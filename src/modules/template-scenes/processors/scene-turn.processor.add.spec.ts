import * as sharp from 'sharp';
import { sceneZonesFor } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import * as retention from '../services/scene-retention';
import { lastReplyOf, logoEl, noModelCalls } from '../testing/scene-operation-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('SceneTurnProcessor: adicionar (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());
  const lastReply = (sceneId: string) => lastReplyOf(h, sceneId);
  const noModels = () => noModelCalls(h);

  describe('adicionar (PNG transparente)', () => {
    const addPlan = (
      target:
        | { kind: 'rect'; rect: { x: number; y: number; w: number; h: number } }
        | { kind: 'zone'; zone: 'header' | 'body' | 'footer' }
        | null,
    ) => ({
      operation: 'add_element' as const,
      subject: 'balão de ar quente',
      target,
    });

    it('No lugar de um item, com área: o elemento nasce na área marcada, com o nome "Cesta de ovos"', async () => {
      const { scene } = await h.readyScene();
      const rect = { x: 0.4, y: 0.7, w: 0.3, h: 0.15 };
      const version = await h.queueTurn(scene, {
        plan: {
          operation: 'add_element',
          subject: 'cesta de ovos',
          target: { kind: 'rect', rect },
        },
        request: 'Adicione uma cesta de ovos no lugar da cerca removida',
        operation: 'add_element',
      });
      const { provider, generateTransparent } = h.fakeProvider(() => h.okResult(), {
        transparent: async (input) => h.mock().generateTransparent(input),
      });

      await h.processorWith(provider).process(h.job(scene.id, version.id));

      expect(generateTransparent.mock.calls[0][0].prompt).toContain('cesta de ovos');
      expect(generateTransparent.mock.calls[0][0].prompt).not.toContain('cerca');
      const added = (await h.versionOf(version.id)).elements[0];
      expect(added.name).toBe('Cesta de ovos');
      expect(added.x).toBeCloseTo(0.55);
      expect(added.y).toBeCloseTo(0.775);
    });

    it('cria um elemento generated com o PNG recortado na área marcada; o fundo não muda', async () => {
      const { scene, masterAsset } = await h.readyScene({ elements: [logoEl] });
      const rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.15 };
      const version = await h.queueTurn(scene, {
        plan: addPlan({ kind: 'rect', rect }),
        request: 'adiciona um balão de ar quente',
        operation: 'add_element',
      });
      const real = h.mock();
      const { provider, generateTransparent } = h.fakeProvider(() => h.okResult(), {
        transparent: async (input) => ({
          ...(await real.generateTransparent(input)),
          costUsd: 0.09,
        }),
      });
      const prune = jest.spyOn(retention, 'pruneSceneAssets');

      await h.processorWith(provider).process(h.job(scene.id, version.id));

      expect(generateTransparent.mock.calls[0][0]).toMatchObject({ size: '1024x1024' });
      expect(generateTransparent.mock.calls[0][0].prompt).toContain('balão de ar quente');
      const done = await h.versionOf(version.id);
      expect(done).toMatchObject({
        status: 'ready',
        operation: 'add_element',
        masterAssetId: masterAsset.id,
        providerCostUsd: 0.09,
      });
      expect(done.metrics.calls).toEqual([
        expect.objectContaining({ kind: 'transparent', costUsd: 0.09 }),
      ]);
      const added = done.elements.find((e) => e.kind === 'generated') as SceneElement;
      expect(done.elements).toHaveLength(2);
      expect(added.name).toBe('Balão de ar quente');
      expect(added.x).toBeCloseTo(0.25);
      expect(added.y).toBeCloseTo(0.175);
      expect(added.w).toBeLessThanOrEqual(0.3);
      const asset = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: added.assetId as string,
      });
      expect(asset).toMatchObject({ role: 'element', versionId: version.id });
      const meta = await sharp(h.files.absolutePath(asset.url)).metadata();
      expect(meta.hasAlpha).toBe(true);
      expect(added.aspect).toBeCloseTo((meta.width as number) / (meta.height as number));
      expect(prune).toHaveBeenCalledTimes(1);
    });

    it('sem área marcada: 25% da largura no centro do miolo', async () => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, {
        plan: addPlan(null),
        request: 'acrescenta uma nuvem',
        operation: 'add_element',
      });
      await h.processorWith(h.mock()).process(h.job(scene.id, version.id));
      const done = await h.versionOf(version.id);
      const added = done.elements[0];
      expect(added).toMatchObject({ kind: 'generated', x: 0.5, w: 0.25 });
      expect(added.y).toBeCloseTo(0.5, 1);
      expect(await lastReply(scene.id)).toContain('no centro do miolo');
    });

    it.each([
      ['header', 'no cabeçalho'],
      ['body', 'no miolo'],
      ['footer', 'no rodapé'],
    ] as const)(
      'zona citada (%s) sem área: no centro da zona, sem esticar, e a resposta nomeia a zona',
      async (zone, wording) => {
        const { scene, masterAsset } = await h.readyScene();
        const version = await h.queueTurn(scene, {
          plan: { ...addPlan({ kind: 'zone', zone }), subject: 'balão' },
          request: `adiciona um balão ${wording}`,
          operation: 'add_element',
        });
        await h.processorWith(h.mock()).process(h.job(scene.id, version.id));
        const done = await h.versionOf(version.id);
        const area = sceneZonesFor(scene.formatId)[zone];
        const added = done.elements[0];
        expect(done).toMatchObject({ status: 'ready', masterAssetId: masterAsset.id });
        expect(added).toMatchObject({ kind: 'generated', name: 'Balão', x: 0.5 });
        expect(added.y).toBeCloseTo(area.y + area.h / 2, 5);
        expect(added.w).toBeLessThanOrEqual(0.25 + 1e-9);
        const heightPx = (added.w * scene.widthPx) / added.aspect;
        expect(heightPx).toBeLessThanOrEqual(area.h * scene.heightPx + 1e-6);
        const reply = await lastReply(scene.id);
        expect(reply).toContain(`"balão" ${wording}.`);
        expect(reply).not.toContain('centro do miolo');
      },
    );

    it('zona estreita reduz a largura para caber na altura, sem esticar', async () => {
      const { scene } = await h.readyScene();
      const area = sceneZonesFor(scene.formatId).footer;
      const version = await h.queueTurn(scene, {
        plan: addPlan({ kind: 'zone', zone: 'footer' }),
        request: 'adiciona um balão no rodapé',
        operation: 'add_element',
      });
      await h.processorWith(h.mock()).process(h.job(scene.id, version.id));
      const added = (await h.versionOf(version.id)).elements[0];
      const fit = ((area.h * scene.heightPx) / scene.widthPx) * added.aspect;
      expect(added.w).toBeCloseTo(Math.min(0.25, fit), 9);
    });

    it('imagem toda transparente: falha com o custo gravado e sem elemento', async () => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, {
        plan: addPlan(null),
        request: 'adiciona um balão',
        operation: 'add_element',
      });
      const empty = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png()
        .toBuffer();
      const { provider } = h.fakeProvider(() => h.okResult(), {
        transparent: async () => ({
          buffer: empty,
          usage: null,
          costUsd: 0.09,
          requestId: 'r',
          latencyMs: 5,
        }),
      });
      await h.processorWith(provider).process(h.job(scene.id, version.id));
      expect(await h.versionOf(version.id)).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
        providerCostUsd: 0.09,
      });
    });

    it('limite antes da imagem: PAID_CALL_LIMIT', async () => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, {
        plan: addPlan(null),
        request: 'adiciona um balão',
        operation: 'add_element',
        overrides: {
          metrics: {
            plan: addPlan(null),
            calls: [
              {
                id: 'c0',
                kind: 'transparent',
                status: 'done',
                model: 'm',
                size: '1x1',
                startedAt: new Date().toISOString(),
              },
            ],
          },
        },
      });
      const fake = noModels();
      await h
        .processorWith(fake.provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' })
        .process(h.job(scene.id, version.id));
      expect(fake.total()).toBe(0);
      expect(await h.versionOf(version.id)).toMatchObject({
        status: 'failed',
        errorCode: 'PAID_CALL_LIMIT',
      });
    });
  });
});
