import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { restorableState, toCurrentVersionView, toMetricsView, toVersionView } from './scene-views';

const asset = (id: string, extra: Partial<TemplateSceneAsset> = {}): TemplateSceneAsset =>
  ({
    id,
    role: 'master',
    url: `/uploads/template-scenes/s/v/${id}.png`,
    width: 100,
    height: 200,
    purgedAt: null,
    ...extra,
  }) as TemplateSceneAsset;

const version = (extra: Partial<TemplateSceneVersion> = {}): TemplateSceneVersion =>
  ({
    id: 'v1',
    number: 1,
    operation: 'generate',
    status: 'ready',
    step: null,
    parentVersionId: null,
    cancelRequestedAt: null,
    errorCode: null,
    providerCostUsd: 0.1,
    latencyMs: 100,
    isOpenManual: false,
    approvedAt: null,
    createdByUserId: null,
    createdAt: new Date('2026-11-04T10:00:00Z'),
    updatedAt: new Date('2026-11-04T10:00:00Z'),
    masterAssetId: 'm1',
    previewAssetId: 'p1',
    elements: [],
    metrics: {},
    requestedRegion: null,
    requestedMask: null,
    targetElementId: null,
    ...extra,
  }) as TemplateSceneVersion;

describe('restorableState', () => {
  it('restaurável: ready com a master em disco', () => {
    expect(restorableState(version(), asset('m1'))).toEqual({ restorable: true, reason: null });
  });

  it('master apagada (purgedAt): não restaurável com o motivo', () => {
    expect(restorableState(version(), asset('m1', { purgedAt: new Date() }))).toEqual({
      restorable: false,
      reason: 'master_purged',
    });
  });

  it('versão sem asset carregado conta como master apagada', () => {
    expect(restorableState(version(), undefined).reason).toBe('master_purged');
  });

  it.each(['queued', 'running', 'failed', 'cancelled', 'rejected'] as const)(
    'versão %s não é restaurável (not_ready)',
    (status) => {
      expect(restorableState(version({ status }), asset('m1')).reason).toBe('not_ready');
    },
  );

  it('ready sem master registrada: not_ready', () => {
    expect(restorableState(version({ masterAssetId: null }), undefined).reason).toBe('not_ready');
  });
});

describe('toVersionView', () => {
  const assets = (purged: boolean) =>
    new Map([
      ['m1', asset('m1', { purgedAt: purged ? new Date() : null })],
      ['p1', asset('p1', { role: 'preview', purgedAt: purged ? new Date() : null })],
    ]);

  it('mostra a prévia quando existe', () => {
    const view = toVersionView(version(), assets(false));
    expect(view.previewUrl).toBe('/uploads/template-scenes/s/v/p1.png');
    expect(view.restorable).toBe(true);
    expect(view.cancelRequested).toBe(false);
  });

  it('prévia apagada: sem miniatura e não restaurável', () => {
    const view = toVersionView(version(), assets(true));
    expect(view.previewUrl).toBeNull();
    expect(view.restorable).toBe(false);
    expect(view.restorableReason).toBe('master_purged');
  });

  it('versão manual compartilha a master de outra: continua restaurável e com miniatura', () => {
    const manual = version({ id: 'v7', number: 7, operation: 'manual' });
    const view = toVersionView(manual, assets(false));
    expect(view.restorable).toBe(true);
    expect(view.previewUrl).not.toBeNull();
  });

  it('cancelamento pedido aparece como cancelRequested', () => {
    const view = toVersionView(
      version({ status: 'running', cancelRequestedAt: new Date('2026-11-04T10:01:00Z') }),
      new Map(),
    );
    expect(view.cancelRequested).toBe(true);
    expect(view.cancelRequestedAt).toBe('2026-11-04T10:01:00.000Z');
  });
});

describe('toCurrentVersionView', () => {
  it('lista master, prévia e a imagem do elemento, sem as apagadas', () => {
    const logo = asset('l1', { role: 'logo' });
    const gone = asset('g1', { role: 'logo', purgedAt: new Date() });
    const current = version({
      elements: [
        {
          id: 'a',
          kind: 'logo',
          name: 'Logo',
          x: 0,
          y: 0,
          w: 0.1,
          aspect: 1,
          rotation: 0,
          z: 1,
          assetId: 'l1',
        },
        {
          id: 'b',
          kind: 'logo',
          name: 'Logo 2',
          x: 0,
          y: 0,
          w: 0.1,
          aspect: 1,
          rotation: 0,
          z: 2,
          assetId: 'g1',
        },
      ],
    });
    const view = toCurrentVersionView(
      current,
      new Map([
        ['m1', asset('m1')],
        ['p1', asset('p1', { role: 'preview' })],
        ['l1', logo],
        ['g1', gone],
      ]),
    );
    expect(view.assets.map((a) => a.id).sort()).toEqual(['l1', 'm1', 'p1']);
    expect(view.master?.id).toBe('m1');
    expect(view.elements).toHaveLength(2);
  });
});

describe('métricas e alvo da edição na versão', () => {
  it('versão sem edição local: metrics null e alvo vazio', () => {
    const view = toVersionView(version(), new Map());
    expect(view).toMatchObject({
      metrics: null,
      requestedRegion: null,
      requestedMask: null,
      targetElementId: null,
    });
  });

  it('edição local: só as métricas públicas, sem calls nem diagnóstico', () => {
    const metrics = {
      plan: { operation: 'local_edit' },
      calls: [],
      insideMaskDiffRatio: 0.91,
      marginDiffRatio: 0.12,
      seamSsim: 0.98,
      maskAreaRatio: 0.04,
      outsideMaskDiffRatio: 1,
      noChange: false,
      vision: { satisfied: 'sim' },
    };
    const region = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const view = toVersionView(
      version({ metrics, requestedRegion: region, targetElementId: null }),
      new Map(),
    );
    expect(view.requestedRegion).toEqual(region);
    expect(view.metrics).toEqual({
      insideMaskDiffRatio: 0.91,
      marginDiffRatio: 0.12,
      seamSsim: 0.98,
      maskAreaRatio: 0.04,
      noChange: false,
      notApplied: false,
      vision: { satisfied: 'sim' },
    });
  });

  it('ajuste geral não atendido: as métricas aparecem só com notApplied e o resto null', () => {
    expect(toMetricsView({ metrics: { notApplied: true, vision: { satisfied: 'nao' } } })).toEqual({
      insideMaskDiffRatio: null,
      marginDiffRatio: null,
      seamSsim: null,
      maskAreaRatio: null,
      noChange: false,
      notApplied: true,
      vision: { satisfied: 'nao' },
    });
    expect(toMetricsView({ metrics: { vision: { satisfied: 'sim' } } })).toBeNull();
  });

  it('sem amostra a métrica vai como null (o chip "preservou X%" não aparece); visão que falhou vira null', () => {
    const view = toMetricsView({
      metrics: { noChange: true, marginDiffRatio: null, seamSsim: null, vision: null },
    });
    expect(view).toEqual({
      insideMaskDiffRatio: null,
      marginDiffRatio: null,
      seamSsim: null,
      maskAreaRatio: null,
      noChange: true,
      notApplied: false,
      vision: null,
    });
  });
});
