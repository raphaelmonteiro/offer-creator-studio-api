import { ProductMetadata } from '../metadata/product-metadata.schema';
import { montarIndice } from './ean-candidate.service';
import { EanItemPipelineService } from './ean-item-pipeline.service';
import type { EanCandidateRecord, JudgmentRecord } from './ean-match.types';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { Gs1PrefixMap } from './gs1-prefix-map';

const m = (title: string, brand: string, extra: Partial<ProductMetadata> = {}) =>
  ({
    title,
    quantity: null,
    alternatives: [{ brand, subBrand: null, variant: null }],
    ean: null,
    ...extra,
  }) as unknown as ProductMetadata;

const INDICE = montarIndice([
  {
    id: 'club',
    filename: 'Club Social - queijo 141g.png',
    url: '/u/club',
    metadata: m('Club Social Queijo', 'Club Social', { ean: '7622300991333' }),
  },
  {
    id: 'cristal',
    filename: 'Uniao - cristal 1kg.jpg',
    url: '/u/c',
    metadata: m('Açúcar Cristal', 'União'),
  },
  {
    id: 'demerara',
    filename: 'Uniao - demerara 1kg.jpg',
    url: '/u/d',
    metadata: m('Açúcar Demerara', 'União'),
  },
  {
    id: 'aviacao-200',
    filename: 'Aviacao - copo 200g.png',
    url: '/u/a',
    metadata: m('Requeijão', 'Aviação', { quantity: { value: 200, unit: 'g' } } as never),
  },
]);

const REF = {
  ean: '7891910000197',
  source: 'off' as const,
  name: 'Açúcar Cristal União 1kg',
  brand: 'União',
  quantity: '1 kg',
  imageUrl: null,
};

function cand(id: string): EanCandidateRecord {
  const img = INDICE.porId.get(id)!;
  return {
    imageId: id,
    filename: img.filename,
    url: img.url,
    title: null,
    brand: img.metadata.alternatives[0].brand,
    variant: null,
    quantity: null,
    score: 0.5,
    textScore: 0.5,
    vectorScore: null,
    origins: ['brand'],
    vetoes: [],
  };
}

function julg(judge: 'A' | 'B', imageIds: string[]): JudgmentRecord {
  return {
    judge,
    model: 'gpt-4o',
    decision: imageIds.length ? 'match' : 'none',
    imageIds,
    labelReadout: imageIds.map((imageId) => ({
      imageId,
      brand: 'União',
      variant: 'Cristal',
      quantity: '1kg',
    })),
    reason: 'x',
    costUsd: 0.02,
  };
}

function criar(opts: {
  gerar: string[];
  juizes?: [string[], string[]];
  anteriores?: unknown[];
  calibrado?: boolean;
}) {
  const dataSource = {
    query: jest.fn(async (sql: string) =>
      sql.includes('FROM ean_match_items') ? (opts.anteriores ?? []) : [],
    ),
  };
  const candidatas = {
    indice: jest.fn().mockResolvedValue(INDICE),
    gerar: jest.fn(async () => opts.gerar.map(cand)),
    prefixMap: jest.fn().mockResolvedValue(new Gs1PrefixMap()),
    invalidar: jest.fn(),
  };
  const referencias = { resolver: jest.fn().mockResolvedValue({ reference: REF, costUsd: 0.015 }) };
  const juizes = opts.juizes ?? [['cristal'], ['cristal']];
  const juiz = {
    version: () => 'ean-judge-v1:abc',
    isEnabled: () => true,
    prepararImagens: jest.fn(async (input: { candidatas: EanCandidateRecord[] }) => ({
      referencia: null,
      candidatas: input.candidatas.map((c) => ({ imageId: c.imageId, dataUrl: 'data:' })),
      detail: 'low',
    })),
    julgar: jest.fn(async (v: 'A' | 'B') => julg(v, v === 'A' ? juizes[0] : juizes[1])),
  };
  const calibracao = { autoAceiteLiberado: jest.fn().mockResolvedValue(opts.calibrado ?? true) };
  const commit = { gravarJob: jest.fn() };
  const service = new EanItemPipelineService(
    dataSource as never,
    candidatas as never,
    referencias as never,
    juiz as never,
    calibracao as never,
    commit as never,
  );
  return { service, juiz, referencias, commit, candidatas };
}

const job = { id: 'job-1', judgeVersion: 'ean-judge-v1:abc' } as EanMatchJob;
const item = (ean: string, description: string) =>
  ({ id: 'item-1', ean, description }) as EanMatchItem;

describe('EanItemPipelineService.processar', () => {
  it('EAN já presente na galeria → exact, sem IA', async () => {
    const { service, juiz, referencias } = criar({ gerar: [] });
    const r = await service.processar(
      item('7622300991333', 'BISCOITO CLUB SOCIAL 141G QUEIJO'),
      job,
    );

    expect(r.patch.status).toBe('exact');
    expect(r.patch.candidates!.map((c) => c.imageId)).toEqual(['club']);
    expect(r.costUsd).toBe(0);
    expect(juiz.julgar).not.toHaveBeenCalled();
    expect(referencias.resolver).not.toHaveBeenCalled();
  });

  it('todas as candidatas vetadas → sem imagem, com os vetos registrados', async () => {
    const { service, juiz } = criar({ gerar: ['aviacao-200'] });
    const r = await service.processar(
      item('7896051100010', 'REQUEIJAO CREMOSO AVIACAO 180GR COPO'),
      job,
    );

    expect(r.patch.status).toBe('no-image');
    expect(r.patch.candidates![0].vetoes[0].reason).toBe('quantity');
    expect(juiz.julgar).not.toHaveBeenCalled();
  });

  it('juízes concordam e a calibração está liberada → auto-aceito, custo somado', async () => {
    const { service } = criar({ gerar: ['cristal', 'demerara'] });
    const r = await service.processar(item('7891910000197', 'ACUCAR CRISTALCUCAR UNIÃO 1KG'), job);

    expect(r.patch).toMatchObject({ status: 'auto-accepted', reviewReason: null });
    expect(r.patch.aiDecision!.imageIds).toEqual(['cristal']);
    expect(r.costUsd).toBeCloseTo(0.015 + 0.04, 6);
  });

  it('juízes divergem → revisão com os dois julgamentos anexados', async () => {
    const { service } = criar({
      gerar: ['cristal', 'demerara'],
      juizes: [['cristal'], ['demerara']],
    });
    const r = await service.processar(item('7891910000197', 'ACUCAR CRISTALCUCAR UNIÃO 1KG'), job);

    expect(r.patch).toMatchObject({ status: 'review', reviewReason: 'judges-disagree' });
    expect(r.patch.judgments!.map((j) => [j.judge, j.imageIds[0]])).toEqual([
      ['A', 'cristal'],
      ['B', 'demerara'],
    ]);
  });

  it('calibração desligada → revisão, nada gravado', async () => {
    const { service } = criar({ gerar: ['cristal', 'demerara'], calibrado: false });
    const r = await service.processar(item('7891910000197', 'ACUCAR CRISTALCUCAR UNIÃO 1KG'), job);
    expect(r.patch).toMatchObject({ status: 'review', reviewReason: 'calibration-off' });
  });

  it('mesmo EAN e mesmas candidatas já julgados → reaproveita sem custo', async () => {
    const anterior = {
      reference: REF,
      judgments: [julg('A', ['cristal']), julg('B', ['cristal'])],
      candidates: [cand('cristal'), cand('demerara')],
    };
    const { service, juiz, referencias } = criar({
      gerar: ['cristal', 'demerara'],
      anteriores: [anterior],
    });
    const r = await service.processar(item('7891910000197', 'ACUCAR CRISTALCUCAR UNIÃO 1KG'), job);

    expect(r.costUsd).toBe(0);
    expect(r.patch.status).toBe('auto-accepted');
    expect(juiz.julgar).not.toHaveBeenCalled();
    expect(referencias.resolver).not.toHaveBeenCalled();
  });

  it('julgamento anterior feito sem referência não é reaproveitado', async () => {
    const anterior = {
      reference: { ...REF, source: 'none', name: null },
      judgments: [julg('A', ['cristal']), julg('B', ['cristal'])],
      candidates: [cand('cristal'), cand('demerara')],
    };
    const { service, juiz } = criar({ gerar: ['cristal', 'demerara'], anteriores: [anterior] });
    await service.processar(item('7891910000197', 'ACUCAR CRISTALCUCAR UNIÃO 1KG'), job);
    expect(juiz.julgar).toHaveBeenCalledTimes(2);
  });

  it('candidatas diferentes das do julgamento anterior → julga de novo', async () => {
    const anterior = {
      reference: REF,
      judgments: [julg('A', ['cristal']), julg('B', ['cristal'])],
      candidates: [cand('cristal')],
    };
    const { service, juiz } = criar({ gerar: ['cristal', 'demerara'], anteriores: [anterior] });
    await service.processar(item('7891910000197', 'ACUCAR CRISTALCUCAR UNIÃO 1KG'), job);
    expect(juiz.julgar).toHaveBeenCalledTimes(2);
  });

  it('finalizarJob grava o job e invalida o cache da galeria', async () => {
    const { service, commit, candidatas } = criar({ gerar: [] });
    await service.finalizarJob(job);
    expect(commit.gravarJob).toHaveBeenCalledWith('job-1');
    expect(candidatas.invalidar).toHaveBeenCalled();
  });
});
