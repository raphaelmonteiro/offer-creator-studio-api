import { DataSource } from 'typeorm';
import { ProductMetadata } from '../metadata/product-metadata.schema';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { conflitoDeFonte, EanMatchCommitService } from './ean-match-commit.service';
import type { AiDecisionRecord, EanMatchItemStatus, HumanDecisionRecord } from './ean-match.types';
import { criarDataSourceDeTeste, EAN_IT_ENABLED, inserirImagem } from './ean-test-db';

const meta = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  alternatives: [{ brand: null, subBrand: null, variant: null }],
  ean: null,
  warnings: [],
  ...extra,
});

describe('conflitoDeFonte', () => {
  const m = (ean: string | null, eanSource?: string) =>
    ({ ean, eanSource }) as unknown as ProductMetadata;
  it.each([
    [m(null), null],
    [m('7890000000001', 'off'), null],
    [m('7890000000001', 'manual'), 'manual-conflict'],
    [m('7890000000001', 'erp'), 'erp-conflict'],
    [m('7891000000002', 'manual'), null], // mesmo EAN
  ])('%o → %s', (metadata, esperado) => {
    expect(conflitoDeFonte(metadata, '7891000000002')).toBe(esperado);
  });
});

const d = EAN_IT_ENABLED ? describe : describe.skip;

d('EanMatchCommitService (Postgres real)', () => {
  let ds: DataSource;
  let service: EanMatchCommitService;
  let jobId: string;
  const imagens: string[] = [];

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
    service = new EanMatchCommitService(ds);
  });

  beforeEach(async () => {
    const job = await ds
      .getRepository(EanMatchJob)
      .save({ status: 'running', fileHash: 'c'.repeat(64) });
    jobId = job.id;
  });

  afterEach(async () => {
    await ds.getRepository(EanMatchJob).delete({ id: jobId });
    if (imagens.length)
      await ds.query(`DELETE FROM gallery_images WHERE id = ANY($1)`, [imagens.splice(0)]);
  });

  afterAll(async () => ds.destroy());

  async function img(filename: string, extra: Record<string, unknown> = {}) {
    const id = await inserirImagem(ds, filename, meta(filename, extra));
    imagens.push(id);
    return id;
  }

  async function item(
    ean: string,
    status: EanMatchItemStatus,
    imageIds: string[],
    opts: { humano?: boolean } = {},
  ): Promise<EanMatchItem> {
    const aiDecision: AiDecisionRecord = {
      decision: imageIds.length > 1 ? 'same-sku-multiple' : 'match',
      imageIds,
      consensus: true,
      autoAcceptEligible: true,
      failed: [],
    };
    const humanDecision: HumanDecisionRecord | null = opts.humano
      ? { decision: 'match', imageIds, userId: 'u1', decidedAt: new Date().toISOString() }
      : null;
    return ds.getRepository(EanMatchItem).save<EanMatchItem>({
      jobId,
      rowNumber: Math.floor(Math.random() * 1e6),
      ean,
      description: `linha ${ean}`,
      status,
      aiDecision: status === 'exact' ? null : aiDecision,
      humanDecision,
      candidates: status === 'exact' ? imageIds.map((imageId) => ({ imageId })) : [],
    } as unknown as EanMatchItem);
  }

  const metaDe = async (id: string): Promise<ProductMetadata> =>
    (await ds.query(`SELECT metadata FROM gallery_images WHERE id = $1`, [id]))[0].metadata;
  const itemDe = (id: string) => ds.getRepository(EanMatchItem).findOneByOrFail({ id });

  it('colisão entre duas decisões da IA: nenhuma grava, ambas vão para revisão', async () => {
    const azul = await img('Suprema - azul 5l.jpg');
    const lava = await item('7896524700001', 'auto-accepted', [azul]); // LAVA ROUPAS SUPREMA 5L AZUL
    const amac = await item('7896524700002', 'auto-accepted', [azul]); // AMACIANTE SUPREMA 5L ROSA

    const r = await service.gravarJob(jobId);

    expect(r.gravados).toBe(0);
    for (const i of [lava, amac])
      expect(await itemDe(i.id)).toMatchObject({ status: 'review', reviewReason: 'collision' });
    expect((await metaDe(azul)).ean).toBeNull();
  });

  it('decisão humana vence a IA na disputa; a IA vai para revisão', async () => {
    const foto = await img('Lacta - ao leite 80g.jpg');
    const humano = await item('7622300000001', 'human-accepted', [foto], { humano: true });
    const ia = await item('7622300000002', 'auto-accepted', [foto]);

    await service.gravarJob(jobId);

    expect(await itemDe(humano.id)).toMatchObject({ status: 'written' });
    expect(await itemDe(ia.id)).toMatchObject({ status: 'review', reviewReason: 'collision' });
    expect(await metaDe(foto)).toMatchObject({ ean: '7622300000001', eanVerifiedBy: 'human' });
  });

  it('mesmo SKU em três fotos: as três recebem o EAN com proveniência', async () => {
    const fotos = [
      await img('Sadia - calabresa.png'),
      await img('Sadia - calabresa 002.png'),
      await img('Sadia - calabresa NOVA.png'),
    ];
    const it1 = await item('7893000000001', 'auto-accepted', fotos);

    await service.gravarJob(jobId);

    expect((await itemDe(it1.id)).writtenImageIds.sort()).toEqual([...fotos].sort());
    for (const f of fotos) {
      expect(await metaDe(f)).toMatchObject({
        ean: '7893000000001',
        eanSource: 'erp',
        eanStatus: 'resolved',
        eanVerifiedBy: 'ai-consensus',
        eanJobId: jobId,
      });
    }
  });

  it('substitui EAN da OFF e guarda o anterior no item', async () => {
    const foto = await img('Heinz - trad 567g.png', { ean: '7800159000240', eanSource: 'off' });
    const it1 = await item('7896102503722', 'auto-accepted', [foto]);

    await service.gravarJob(jobId);

    expect(await metaDe(foto)).toMatchObject({ ean: '7896102503722', eanSource: 'erp' });
    const salvo = await itemDe(it1.id);
    expect(salvo.previousMetadata![foto]).toMatchObject({ ean: '7800159000240', eanSource: 'off' });
  });

  it('EAN manual diferente não é tocado: item vai para revisão', async () => {
    const foto = await img('Produto manual.png', { ean: '7890000000017', eanSource: 'manual' });
    const it1 = await item('7891000000002', 'auto-accepted', [foto]);

    await service.gravarJob(jobId);

    expect(await itemDe(it1.id)).toMatchObject({
      status: 'review',
      reviewReason: 'manual-conflict',
    });
    expect(await metaDe(foto)).toMatchObject({ ean: '7890000000017', eanSource: 'manual' });
  });

  it('item com várias fotos e uma em conflito não grava nenhuma', async () => {
    const livre = await img('Livre.png');
    const manual = await img('Manual.png', { ean: '7890000000017', eanSource: 'manual' });
    const it1 = await item('7891000000002', 'auto-accepted', [livre, manual]);

    await service.gravarJob(jobId);

    expect((await itemDe(it1.id)).status).toBe('review');
    expect((await metaDe(livre)).ean).toBeNull();
  });

  it('EAN exato confirma a imagem como erp/exact', async () => {
    const foto = await img('Club Social - queijo.png', { ean: '7622300991333', eanSource: 'off' });
    await item('7622300991333', 'exact', [foto]);

    await service.gravarJob(jobId);

    expect(await metaDe(foto)).toMatchObject({
      ean: '7622300991333',
      eanSource: 'erp',
      eanVerifiedBy: 'exact',
    });
  });

  it('reverter o job restaura o metadata anterior, exceto imagens alteradas depois', async () => {
    const a = await img('A.png', { ean: '7800159000240', eanSource: 'off' });
    const b = await img('B.png');
    await item('7896102503722', 'auto-accepted', [a]);
    await item('7891000000002', 'auto-accepted', [b]);
    await service.gravarJob(jobId);

    // Alguém grava B manualmente depois do job.
    const mb = await metaDe(b);
    await ds.query(`UPDATE gallery_images SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ ...mb, ean: '7890000000017', eanSource: 'manual', eanJobId: null }),
      b,
    ]);

    const r = await service.reverterJob(jobId);

    expect(r.revertidas).toBe(1);
    expect(r.naoRevertidas).toEqual([b]);
    expect(await metaDe(a)).toMatchObject({ ean: '7800159000240', eanSource: 'off' });
    expect(await metaDe(b)).toMatchObject({ ean: '7890000000017', eanSource: 'manual' });
  });
});
