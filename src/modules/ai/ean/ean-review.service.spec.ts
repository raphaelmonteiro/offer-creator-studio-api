import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { EanMatchCommitService } from './ean-match-commit.service';
import type { AiDecisionRecord, EanCandidateRecord, EanMatchItemStatus } from './ean-match.types';
import { alocarProporcional, EanReviewService, faixaDeScore } from './ean-review.service';
import { criarDataSourceDeTeste, EAN_IT_ENABLED, inserirImagem } from './ean-test-db';

describe('alocarProporcional', () => {
  const estratos = new Map<string, string[]>([
    ['calibration-off|alto', Array.from({ length: 600 }, (_, i) => `a${i}`)],
    ['judges-disagree|medio', Array.from({ length: 300 }, (_, i) => `b${i}`)],
    ['no-image|baixo', Array.from({ length: 95 }, (_, i) => `c${i}`)],
    ['label-mismatch|alto', ['d0', 'd1']],
  ]);

  it('devolve exatamente o tamanho pedido, proporcional, com todos os estratos', () => {
    const r = alocarProporcional(estratos, 200);
    expect(r).toHaveLength(200);
    const por = (p: string) => r.filter((id) => id.startsWith(p)).length;
    expect(por('a')).toBeGreaterThan(por('b'));
    expect(por('b')).toBeGreaterThan(por('c'));
    expect(por('d')).toBeGreaterThanOrEqual(1); // estrato raro não some
    expect(new Set(r).size).toBe(200);
  });

  it('pool menor que a amostra devolve tudo', () => {
    expect(alocarProporcional(new Map([['x', ['1', '2']]]), 200)).toEqual(['1', '2']);
  });

  it('mais estratos que vagas não trava', () => {
    const muitos = new Map(
      Array.from({ length: 10 }, (_, i) => [`e${i}`, [`${i}a`, `${i}b`]] as [string, string[]]),
    );
    expect(alocarProporcional(muitos, 5).length).toBeGreaterThanOrEqual(5);
  });
});

describe('faixaDeScore', () => {
  const c = (score: number, vetada = false) =>
    ({ score, vetoes: vetada ? [{ reason: 'quantity' }] : [] }) as unknown as EanCandidateRecord;
  it('usa só as sobreviventes', () => {
    expect(faixaDeScore({ candidates: [c(0.9, true), c(0.4)] })).toBe('medio');
    expect(faixaDeScore({ candidates: [] })).toBe('baixo');
  });
});

const d = EAN_IT_ENABLED ? describe : describe.skip;

d('EanReviewService (Postgres real)', () => {
  let ds: DataSource;
  let service: EanReviewService;
  let jobId: string;
  const imagens: string[] = [];

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
    const calibracao = { autoAceiteLiberado: jest.fn().mockResolvedValue(true) };
    service = new EanReviewService(ds, new EanMatchCommitService(ds), calibracao as never);
  });
  beforeEach(async () => {
    jobId = (
      await ds
        .getRepository(EanMatchJob)
        .save({ status: 'done', fileHash: 'r'.repeat(64), judgeVersion: 'v1' })
    ).id;
  });
  afterEach(async () => {
    await ds.getRepository(EanMatchJob).delete({ id: jobId });
    if (imagens.length)
      await ds.query(`DELETE FROM gallery_images WHERE id = ANY($1)`, [imagens.splice(0)]);
  });
  afterAll(async () => ds.destroy());

  async function img(nome: string) {
    const id = await inserirImagem(ds, nome, {
      title: nome,
      alternatives: [{ brand: null }],
      ean: null,
      warnings: [],
    });
    imagens.push(id);
    return id;
  }
  const cand = (imageId: string) =>
    ({
      imageId,
      filename: imageId,
      url: '',
      score: 0.7,
      vetoes: [],
    }) as unknown as EanCandidateRecord;
  const ai = (imageIds: string[]): AiDecisionRecord => ({
    decision: 'match',
    imageIds,
    consensus: true,
    autoAcceptEligible: true,
    failed: ['calibration-off'],
  });

  async function item(ean: string, candidatas: string[], extra: Partial<EanMatchItem> = {}) {
    return ds.getRepository(EanMatchItem).save<EanMatchItem>({
      jobId,
      rowNumber: Math.floor(Math.random() * 1e6),
      ean,
      description: `linha ${ean}`,
      status: 'review' as EanMatchItemStatus,
      reviewReason: 'calibration-off',
      candidates: candidatas.map(cand),
      aiDecision: ai(candidatas.slice(0, 1)),
      judgments: [{ judge: 'A' }, { judge: 'B' }] as never,
      ...extra,
    } as EanMatchItem);
  }
  const metaDe = async (id: string) =>
    (await ds.query(`SELECT metadata FROM gallery_images WHERE id = $1`, [id]))[0].metadata;

  it('decisão "match" grava na galeria com verificação humana', async () => {
    const a = await img('Uniao - cristal.jpg');
    const b = await img('Uniao - cristal 002.jpg');
    const it1 = await item('7891910000197', [a, b]);

    const r = await service.decidir(it1.id, { decision: 'match', imageIds: [a, b] }, 'user-1');

    expect(r.status).toBe('written');
    expect(r.humanDecision).toMatchObject({ decision: 'match', userId: 'user-1' });
    for (const id of [a, b])
      expect(await metaDe(id)).toMatchObject({
        ean: '7891910000197',
        eanVerifiedBy: 'human',
        eanSource: 'erp',
      });
  });

  it('decisão "nenhuma" encerra o item sem tocar a galeria', async () => {
    const a = await img('Heinz - picles.png');
    const it1 = await item('7896102503722', [a]);
    const r = await service.decidir(it1.id, { decision: 'none' }, 'user-1');
    expect(r.status).toBe('human-none');
    expect((await metaDe(a)).ean).toBeNull();
  });

  it('humano × humano na mesma imagem com EANs diferentes → 409', async () => {
    const a = await img('Suprema - azul 5l.jpg');
    const x = await item('7896524700001', [a]);
    const y = await item('7896524700002', [a]);
    await service.decidir(x.id, { decision: 'match', imageIds: [a] }, 'u1');
    await expect(service.decidir(y.id, { decision: 'match', imageIds: [a] }, 'u2')).rejects.toThrow(
      ConflictException,
    );
  });

  it('decisão humana tira a IA da disputa e reverte o que ela gravou', async () => {
    const a = await img('Lacta - ao leite.jpg');
    const daIa = await item('7622300000002', [a], { status: 'auto-accepted', reviewReason: null });
    await new EanMatchCommitService(ds).gravarJob(jobId);
    expect(await metaDe(a)).toMatchObject({ ean: '7622300000002', eanVerifiedBy: 'ai-consensus' });

    const humano = await item('7622300000001', [a]);
    await service.decidir(humano.id, { decision: 'match', imageIds: [a] }, 'u1');

    expect(await metaDe(a)).toMatchObject({ ean: '7622300000001', eanVerifiedBy: 'human' });
    expect(await ds.getRepository(EanMatchItem).findOneByOrFail({ id: daIa.id })).toMatchObject({
      status: 'review',
      reviewReason: 'collision',
    });
  });

  it('imagem fora das candidatas é recusada', async () => {
    const a = await img('A.png');
    const it1 = await item('7891000000002', [a]);
    await expect(
      service.decidir(
        it1.id,
        { decision: 'match', imageIds: ['00000000-0000-4000-8000-000000000000'] },
        'u',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('item de calibração esconde a opinião da IA do revisor', async () => {
    const a = await img('A.png');
    const it1 = await item('7891000000002', [a], {
      isCalibration: true,
      reviewReason: 'calibration-sample',
    });
    const r = await service.buscar(it1.id);
    expect(r.aiDecision).toBeNull();
    expect(r.judgments).toBeNull();
    expect(r.candidates).toHaveLength(1);
  });

  it('amostra de calibração marca itens (inclusive auto-aceitos) e os devolve à fila', async () => {
    const a = await img('A.png');
    await item('7891000000002', [a], { status: 'auto-accepted', reviewReason: null });
    await item('7891000000019', [a]);
    await item('7891000000026', [a], { aiDecision: null }); // sem julgamento: fora

    const r = await service.montarAmostraCalibracao(jobId, 200);
    expect(r.selecionados).toBe(2);
    const fila = await service.listar({ jobId, calibracao: true });
    expect(fila.total).toBe(2);
    expect(fila.itens.every((i) => i.reviewReason === 'calibration-sample')).toBe(true);
  });

  it('após calibração aprovada, reavaliar aceita e grava o que só esperava por ela', async () => {
    const a = await img('A.png');
    const b = await img('B.png');
    await item('7891000000002', [a]);
    await item('7891000000019', [b], {
      aiDecision: { ...ai([b]), autoAcceptEligible: false, failed: ['label-mismatch'] },
      reviewReason: 'label-mismatch',
    });

    const r = await service.reavaliarAposCalibracao(jobId);

    expect(r).toEqual({ aceitos: 1, gravados: 1 });
    expect(await metaDe(a)).toMatchObject({ ean: '7891000000002', eanVerifiedBy: 'ai-consensus' });
    expect((await metaDe(b)).ean).toBeNull();
  });
});
