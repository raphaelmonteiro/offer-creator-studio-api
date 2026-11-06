import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { restorableState, toCurrentVersionView, toVersionView } from './scene-views';

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

describe('número exibido, janela e juiz na versão', () => {
  it('displayNumber vem do mapa da cena inteira; sem entrada, null', () => {
    const v = version();
    expect(toVersionView(v, new Map(), new Map([[v.id, 7]])).displayNumber).toBe(7);
    expect(toVersionView(v, new Map()).displayNumber).toBeNull();
  });

  it('windowEndsAt sai de metrics, e só se for uma data válida', () => {
    const at = '2026-11-06T12:00:05.000Z';
    expect(toVersionView(version({ metrics: { windowEndsAt: at } }), new Map()).windowEndsAt).toBe(
      at,
    );
    expect(
      toVersionView(version({ metrics: { windowEndsAt: 'ontem' } }), new Map()).windowEndsAt,
    ).toBeNull();
    expect(toVersionView(version(), new Map()).windowEndsAt).toBeNull();
  });

  it('judge traz só o veredito conhecido', () => {
    const judge = (satisfied: unknown) =>
      toVersionView(version({ metrics: { judge: { available: true, satisfied } } }), new Map())
        .judge;
    expect(judge('nao')).toBe('nao');
    expect(judge('parcial')).toBe('parcial');
    expect(judge('sim')).toBe('sim');
    expect(judge('talvez')).toBeNull();
    expect(
      toVersionView(version({ metrics: { judge: { available: false } } }), new Map()).judge,
    ).toBeNull();
    expect(toVersionView(version(), new Map()).judge).toBeNull();
  });

  it('a versão atual leva o número exibido', () => {
    const v = version();
    expect(toCurrentVersionView(v, new Map(), new Map([[v.id, 3]])).displayNumber).toBe(3);
  });
});

describe('alvo da edição na versão', () => {
  it('versão sem marcação: alvo vazio e sem imagem nova', () => {
    const view = toVersionView(version(), new Map());
    expect(view).toMatchObject({
      isNewImage: false,
      requestedRegion: null,
      requestedMask: null,
      targetElementId: null,
    });
    expect(view).not.toHaveProperty('metrics');
    expect(view).not.toHaveProperty('targetSource');
  });

  it('Imagem nova: isNewImage vem do plano do Diretor', () => {
    const plan = { turn_kind: 'imagem_nova' };
    expect(toVersionView(version({ metrics: { plan } }), new Map()).isNewImage).toBe(true);
  });

  it('a marcação gravada volta na versão, e as métricas internas não saem', () => {
    const region = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const view = toVersionView(
      version({
        metrics: { plan: { turn_kind: 'pedido_item' }, calls: [], director: { costUsd: 1 } },
        requestedRegion: region,
      }),
      new Map(),
    );
    expect(view.requestedRegion).toEqual(region);
    expect(JSON.stringify(view)).not.toContain('director');
    expect(JSON.stringify(view)).not.toContain('calls');
  });
});
