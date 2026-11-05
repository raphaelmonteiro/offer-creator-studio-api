import { DataSource } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { insertReadyVersion, insertScene } from '../testing/scene-fixtures';
import { errorOf } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneLockService } from './scene-lock.service';
import { SceneTurnService } from './scene-turn.service';

const RECT = { x: 0.6, y: 0.05, w: 0.3, h: 0.15 };

describeIfSceneDb('SceneTurnService: classificação do pedido (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let service: SceneTurnService;
  let publish: jest.Mock;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
  });

  beforeEach(() => {
    publish = jest.fn(async () => `job-${publish.mock.calls.length}`);
    service = new SceneTurnService(dataSource, new SceneLockService(dataSource), {
      publish,
    } as unknown as AnimationQueueService);
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
  });

  /** Cena com a versão 1 pronta (revisão 0). */
  async function readyScene(name: string, elements: TemplateSceneVersion['elements'] = []) {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    const { version } = await insertReadyVersion(dataSource, scene, 1, { elements });
    scene.currentVersionId = version.id;
    await dataSource.manager.save(scene);
    return scene;
  }
  const send = (sceneId: string, body: Record<string, unknown>, revision = 0) =>
    service.sendMessage(
      sceneId,
      { content: 'x', expectedRevision: revision, ...body } as never,
      null,
    );
  const versionsOf = (sceneId: string) =>
    dataSource.manager.find(TemplateSceneVersion, { where: { sceneId }, order: { number: 'ASC' } });
  const sceneOf = (id: string) => dataSource.manager.findOneByOrFail(TemplateScene, { id });

  it('item citado sem área: responde "marque a área", sem job, versão rejected e custo intacto', async () => {
    const scene = await readyScene('Cls item');
    const result = await send(scene.id, { content: 'coloca um brilho no sol' });

    expect(result).toMatchObject({ jobId: null, operation: 'needs_region', revision: 1 });
    expect(result.assistantMessage?.content).toContain('Marque a área');
    expect(publish).not.toHaveBeenCalled();
    const [, rejected] = await versionsOf(scene.id);
    expect(rejected).toMatchObject({ status: 'rejected', providerCostUsd: 0, number: 2 });
    expect((await sceneOf(scene.id)).totalCostUsd).toBe(0);
    const messages = await dataSource.manager.find(TemplateSceneMessage, {
      where: { versionId: rejected.id },
      order: { createdAt: 'ASC' },
    });
    expect(messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done'],
    ]);
  });

  it('mover um item da imagem: explica e oferece remover e adicionar, sem job', async () => {
    const scene = await readyScene('Cls mover');
    const result = await send(scene.id, { content: 'troca o sol de lado' });
    expect(result).toMatchObject({ jobId: null, operation: 'move_unavailable' });
    expect(result.assistantMessage?.content).toContain('sem refazê-lo');
    expect(publish).not.toHaveBeenCalled();
  });

  it('zona citada no texto: edição local com o retângulo do cabeçalho do formato', async () => {
    const scene = await readyScene('Cls zona');
    const result = await send(scene.id, { content: 'deixa o céu do cabeçalho mais limpo' });

    expect(result).toMatchObject({ operation: 'local_edit', jobId: 'job-1' });
    const [, queued] = await versionsOf(scene.id);
    expect(queued).toMatchObject({
      operation: 'local_edit',
      status: 'queued',
      parentVersionId: scene.currentVersionId,
    });
    expect(queued.requestedRegion).toMatchObject({ x: 0, y: 0, w: 1 });
    expect(queued.requestedRegion!.h).toBeCloseTo(0.1111, 3);
    expect(queued.metrics.plan).toMatchObject({
      operation: 'local_edit',
      target: { kind: 'zone', zone: 'header' },
    });
  });

  it('"remover o sol" com área marcada: edição local de remoção, e não mover', async () => {
    const scene = await readyScene('Cls remover');
    const result = await send(scene.id, { content: 'remover o sol', region: RECT });
    expect(result.operation).toBe('local_edit');
    const [, queued] = await versionsOf(scene.id);
    expect(queued.requestedRegion).toEqual(RECT);
    expect(queued.metrics.plan).toMatchObject({ remove: true });
  });

  it('laço: guarda a forma e a caixa dela', async () => {
    const scene = await readyScene('Cls laço');
    const mask = {
      kind: 'lasso',
      points: [
        { x: 0.6, y: 0.1 },
        { x: 0.8, y: 0.1 },
        { x: 0.7, y: 0.3 },
      ],
    };
    await send(scene.id, { content: 'deixa o sol mais brilhante', mask });
    const [, queued] = await versionsOf(scene.id);
    expect(queued.requestedMask).toEqual(mask);
    expect(queued.requestedRegion).toMatchObject({ x: 0.6, y: 0.1 });
  });

  it('adicionar com área marcada: operação add_element e job', async () => {
    const scene = await readyScene('Cls adicionar');
    const result = await send(scene.id, {
      content: 'adiciona um balão de ar quente',
      region: RECT,
    });
    expect(result.operation).toBe('add_element');
    const [, queued] = await versionsOf(scene.id);
    expect(queued).toMatchObject({ operation: 'add_element', status: 'queued' });
    expect(queued.metrics.plan).toMatchObject({ subject: 'balão de ar quente' });
  });

  it('mover a logo: set_layer em job, sem modelo', async () => {
    const scene = await readyScene('Cls logo');
    const result = await send(scene.id, { content: 'passa a logo para a direita' });
    expect(result.operation).toBe('set_layer');
    const [, queued] = await versionsOf(scene.id);
    expect(queued.operation).toBe('set_layer');
  });

  describe('alvo duplo e limites', () => {
    it('região e elemento selecionado juntos: 400 e nada gravado', async () => {
      const scene = await readyScene('Cls duplo');
      expect(
        await errorOf(send(scene.id, { content: 'x', region: RECT, targetElementId: 'e1' })),
      ).toEqual({ status: 400, code: 'BAD_REQUEST' });
      expect(await versionsOf(scene.id)).toHaveLength(1);
      expect((await sceneOf(scene.id)).revision).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    });

    it.each([
      ['region + mask', { region: RECT, mask: { kind: 'lasso', points: [] } }],
      ['zone + region', { zone: 'header', region: RECT }],
      ['mask + zone', { mask: { kind: 'lasso', points: [] }, zone: 'footer' }],
    ])('%s: 400', async (_name, body) => {
      const scene = await readyScene('Cls pares');
      expect((await errorOf(send(scene.id, body))).status).toBe(400);
    });

    it('área abaixo de 0,1% da cena: 422 REGION_TOO_SMALL', async () => {
      const scene = await readyScene('Cls pequena');
      expect(
        await errorOf(
          send(scene.id, { content: 'x', region: { x: 0.1, y: 0.1, w: 0.02, h: 0.02 } }),
        ),
      ).toEqual({ status: 422, code: 'REGION_TOO_SMALL' });
      const tiny = {
        kind: 'lasso',
        points: [
          { x: 0.5, y: 0.5 },
          { x: 0.51, y: 0.5 },
          { x: 0.5, y: 0.51 },
        ],
      };
      expect(await errorOf(send(scene.id, { content: 'x', mask: tiny }))).toEqual({
        status: 422,
        code: 'REGION_TOO_SMALL',
      });
      expect(await versionsOf(scene.id)).toHaveLength(1);
    });

    it('região logo acima do mínimo é aceita', async () => {
      const scene = await readyScene('Cls limite');
      const result = await send(scene.id, {
        content: 'deixa o sol mais brilhante',
        region: { x: 0.1, y: 0.1, w: 0.04, h: 0.03 },
      });
      expect(result.operation).toBe('local_edit');
    });

    it('elemento selecionado que não existe: 422 TARGET_ELEMENT_NOT_FOUND', async () => {
      const scene = await readyScene('Cls sem elemento');
      expect(
        await errorOf(send(scene.id, { content: 'aumenta', targetElementId: 'nao-existe' })),
      ).toEqual({
        status: 422,
        code: 'TARGET_ELEMENT_NOT_FOUND',
      });
    });

    it('elemento selecionado que existe: set_layer com o id', async () => {
      const scene = await readyScene('Cls elemento', [
        {
          id: 'logo-1',
          kind: 'logo',
          name: 'Logo',
          x: 0.2,
          y: 0.1,
          w: 0.3,
          aspect: 2,
          rotation: 0,
          z: 1,
        },
      ]);
      const result = await send(scene.id, { content: 'aumenta', targetElementId: 'logo-1' });
      expect(result.operation).toBe('set_layer');
    });
  });

  describe('ajuste geral com confirmação', () => {
    it('pergunta primeiro (sem job) e só depois da confirmação enfileira o ajuste', async () => {
      const scene = await readyScene('Cls global');
      const asked = await send(scene.id, { content: 'deixa tudo mais quente' });
      expect(asked).toMatchObject({ jobId: null, operation: 'needs_confirmation_global' });
      expect(asked.assistantMessage?.content).toContain('fundo inteiro');
      expect(publish).not.toHaveBeenCalled();

      const confirmed = await send(
        scene.id,
        { content: 'Confirmar', confirmGlobal: true, replyToMessageId: asked.assistantMessage!.id },
        asked.revision,
      );

      expect(confirmed).toMatchObject({ operation: 'global_regenerate', jobId: 'job-1' });
      const versions = await versionsOf(scene.id);
      expect(versions[2]).toMatchObject({ operation: 'generate', status: 'queued' });
      expect(versions[2].metrics.plan).toMatchObject({
        operation: 'global_regenerate',
        instruction: 'deixa tudo mais quente',
      });
    });

    it('repetir a confirmação não duplica o ajuste: 409 CONFIRMATION_NOT_PENDING', async () => {
      const scene = await readyScene('Cls global repetida');
      const asked = await send(scene.id, { content: 'deixa tudo mais quente' });
      const confirm = (revision: number) =>
        send(
          scene.id,
          { content: 'sim', confirmGlobal: true, replyToMessageId: asked.assistantMessage!.id },
          revision,
        );
      const first = await confirm(asked.revision);
      // a versão em curso termina (simula o worker) e a mesma confirmação chega de novo
      await dataSource.manager.update(
        TemplateSceneVersion,
        { id: first.versionId },
        { status: 'failed' },
      );
      expect(await errorOf(confirm(first.revision))).toEqual({
        status: 409,
        code: 'CONFIRMATION_NOT_PENDING',
      });
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('confirmar sem replyToMessageId: 400; resposta a mensagem que não é pergunta: 409', async () => {
      const scene = await readyScene('Cls global inválida');
      expect((await errorOf(send(scene.id, { confirmGlobal: true }))).status).toBe(400);
      const answered = await send(scene.id, { content: 'troca o sol de lado' });
      expect(
        await errorOf(
          send(
            scene.id,
            { confirmGlobal: true, replyToMessageId: answered.assistantMessage!.id },
            answered.revision,
          ),
        ),
      ).toEqual({ status: 409, code: 'CONFIRMATION_NOT_PENDING' });
    });
  });

  it('a primeira mensagem de uma cena sem versão pronta continua sendo a geração', async () => {
    const scene = await insertScene(dataSource, { name: 'Cls primeira' });
    createdScenes.push(scene.id);
    const result = await send(scene.id, { content: 'campo verde com sol' });
    expect(result.operation).toBe('generate');
    const [version] = await versionsOf(scene.id);
    expect(version).toMatchObject({ operation: 'generate', status: 'queued' });
  });
});
