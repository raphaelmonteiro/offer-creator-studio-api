import { SceneElement } from '../domain/scene.types';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { useTurnServiceHarness } from '../testing/scene-turn-service-harness';

const PHRASE =
  'integre esta cesta ai cenario de fundo como se ela divesse colocada no gramado, e são ovos de pascoa nao de galhinha';
const basket: SceneElement = {
  id: 'cesta-1',
  kind: 'generated',
  name: 'Cesta de ovos',
  x: 0.5,
  y: 0.5,
  w: 0.3,
  aspect: 1,
  rotation: 0,
  z: 1,
  assetId: 'a-cesta',
};
const second: SceneElement = {
  ...basket,
  id: 'balao-1',
  name: 'Balão',
  x: 0.52,
  assetId: 'a-balao',
};
const AREA = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };

describeIfSceneDb('SceneTurnService: integrar uma camada ao fundo (banco chroma_x_e2e)', () => {
  const h = useTurnServiceHarness();

  it('Integrar a cesta com área marcada: edição local da área, com a camada como alvo da integração', async () => {
    const scene = await h.readyScene('Integra área', [basket]);

    const result = await h.send(scene.id, { content: PHRASE, region: AREA });

    expect(result).toMatchObject({ operation: 'local_edit', jobId: 'job-1' });
    const queued = (await h.versionsOf(scene.id))[1];
    expect(queued.requestedRegion).toEqual(AREA);
    expect(queued.metrics.plan).toMatchObject({
      operation: 'local_edit',
      target: { kind: 'rect' },
      integrate: true,
      integrateLayer: { elementId: 'cesta-1', name: 'Cesta de ovos' },
    });
  });

  it('Integrar com a camada selecionada: a edição vale para a caixa dela', async () => {
    const scene = await h.readyScene('Integra seleção', [basket, second]);

    const result = await h.send(scene.id, {
      content: 'integra ao fundo',
      targetElementId: 'cesta-1',
    });

    expect(result.operation).toBe('local_edit');
    const queued = (await h.versionsOf(scene.id))[1];
    expect(queued.targetElementId).toBe('cesta-1');
    expect(queued.metrics.plan).toMatchObject({
      target: { kind: 'element', elementId: 'cesta-1' },
      integrateLayer: { elementId: 'cesta-1' },
    });
  });

  it('Duas camadas possíveis: pede para selecionar, sem job e sem custo', async () => {
    const scene = await h.readyScene('Integra duas', [basket, second]);

    const result = await h.send(scene.id, { content: 'integra isso ao fundo', region: AREA });

    expect(result).toMatchObject({ jobId: null, operation: 'needs_region' });
    expect(result.assistantMessage?.content).toContain('Selecione na prévia');
    expect(h.publish).not.toHaveBeenCalled();
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBe(0);
  });

  it('duas camadas na área, mas o texto cita uma pelo nome: ela é o alvo', async () => {
    const scene = await h.readyScene('Integra nome', [basket, second]);

    const result = await h.send(scene.id, { content: 'integra a cesta ao fundo', region: AREA });

    expect(result.operation).toBe('local_edit');
    expect((await h.versionsOf(scene.id))[1].metrics.plan).toMatchObject({
      integrateLayer: { elementId: 'cesta-1' },
    });
  });

  it('sem marcação, uma única camada citada pelo nome: a caixa dela é a área', async () => {
    const scene = await h.readyScene('Integra sem marcar', [basket, second]);

    const result = await h.send(scene.id, { content: 'integre esta cesta ao cenário' });

    expect(result.operation).toBe('local_edit');
    expect((await h.versionsOf(scene.id))[1].targetElementId).toBe('cesta-1');
  });

  it('Nome citado com menos de metade na área: a camada é o alvo e a área continua a marcada (D-21)', async () => {
    const scene = await h.readyScene('Integra nome fora da área', [basket, second]);
    const far = { x: 0.05, y: 0.05, w: 0.2, h: 0.1 };

    const result = await h.send(scene.id, { content: 'integra a cesta ao fundo', region: far });

    expect(result).toMatchObject({ operation: 'local_edit', jobId: 'job-1' });
    const queued = (await h.versionsOf(scene.id))[1];
    expect(queued.requestedRegion).toEqual(far);
    expect(queued.metrics.plan).toMatchObject({
      target: { kind: 'rect', rect: far },
      integrate: true,
      integrateLayer: { elementId: 'cesta-1', name: 'Cesta de ovos' },
    });
  });

  it.each([
    ['com área marcada', { region: AREA }],
    ['sem marcação', {}],
  ])(
    'Nome citado ambíguo, %s: pede para selecionar a camada, sem job e sem imagem',
    async (_l, target) => {
      const palha: SceneElement = {
        ...basket,
        id: 'cesta-2',
        name: 'Cesta de palha',
        x: 0.2,
        y: 0.2,
      };
      const scene = await h.readyScene('Integra nome ambíguo', [basket, palha]);

      const result = await h.send(scene.id, { content: 'integra a cesta ao fundo', ...target });

      expect(result).toMatchObject({ jobId: null, operation: 'needs_region' });
      expect(result.assistantMessage?.content).toContain('Selecione na prévia');
      expect(h.publish).not.toHaveBeenCalled();
      expect((await h.versionsOf(scene.id))[1].metrics.plan).toMatchObject({
        reason: 'choose_layer',
      });
    },
  );

  it('R29: integrar sem alvo e sem marcação pede a área, nunca o ajuste geral', async () => {
    const scene = await h.readyScene('Integra sem alvo', [basket, second]);

    for (const [i, content] of [
      'integra ao fundo',
      'integra ela ao fundo',
      'mescla com o fundo',
    ].entries()) {
      const result = await h.send(scene.id, { content }, i);
      expect(result).toMatchObject({ jobId: null, operation: 'needs_region' });
      expect(result.assistantMessage?.content).toContain('Marque a área');
    }
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('sem marcação e sem camada citada: pede a marcação, sem job', async () => {
    const scene = await h.readyScene('Integra sem camada', [basket]);
    const result = await h.send(scene.id, { content: 'integre esta coisa ao cenário' });
    expect(result).toMatchObject({ jobId: null, operation: 'needs_region' });
  });

  it('nenhuma camada na área e nenhum nome citado: edição local comum, sem integração', async () => {
    const scene = await h.readyScene('Integra nenhuma', [basket]);
    const far = { x: 0.05, y: 0.05, w: 0.2, h: 0.1 };

    const result = await h.send(scene.id, { content: 'integra isso ao fundo', region: far });

    expect(result.operation).toBe('local_edit');
    const plan = (await h.versionsOf(scene.id))[1].metrics.plan as Record<string, unknown>;
    expect(plan.integrateLayer).toBeUndefined();
    expect(plan.integrate).toBe(false);
  });

  it('logo e texto não são integrados: com área, vira edição comum do fundo', async () => {
    const logo: SceneElement = { ...basket, id: 'logo-1', kind: 'logo', name: 'Logo 1' };
    const scene = await h.readyScene('Integra logo', [logo]);

    await h.send(scene.id, { content: 'integra a logo ao fundo', region: AREA });

    const plan = (await h.versionsOf(scene.id))[1].metrics.plan as Record<string, unknown>;
    expect(plan.integrateLayer).toBeUndefined();
  });
});
