import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { MockSceneImageProvider } from '../providers/mock-scene-image.provider';
import {
  SceneGenerateInput,
  SceneGenerateResult,
  SceneImageProvider,
  SceneProviderError,
} from '../providers/scene-image-provider';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneFilesService } from '../services/scene-files.service';
import { SceneLockService } from '../services/scene-lock.service';
import {
  insertMessage,
  insertReadyVersion,
  insertScene,
  insertVersion,
} from '../testing/scene-fixtures';
import {
  deleteTestScenes,
  describeIfSceneDb,
  openSceneTestDb,
  SCENE_DB_URL,
} from '../testing/scene-test-db';
import { SceneTurnProcessor } from './scene-turn.processor';
import { SceneTurnState } from './scene-turn-state';

describeIfSceneDb('SceneTurnProcessor (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let uploadsDir: string;
  let files: SceneFilesService;
  let state: SceneTurnState;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await openSceneTestDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-turn-'));
    files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: uploadsDir }));
    state = new SceneTurnState(new SceneLockService(dataSource));
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  const config = (env: Record<string, string> = {}) =>
    new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0', ...env });
  const mock = (env: Record<string, string> = {}) => new MockSceneImageProvider(config(env));

  function processorWith(provider: SceneImageProvider, env: Record<string, string> = {}) {
    return new SceneTurnProcessor(state, files, config(env), provider);
  }

  /** Cena folheto 1920x3840 com uma versão `queued` e a mensagem do pedido. */
  async function queuedScene(request: string, overrides: Partial<TemplateSceneVersion> = {}) {
    const scene = await insertScene(dataSource, { name: `Processor ${request.slice(0, 20)}` });
    createdScenes.push(scene.id);
    const version = await insertVersion(dataSource, scene.id, {
      number: 1,
      status: 'queued',
      ...overrides,
    });
    await insertMessage(dataSource, scene.id, {
      versionId: version.id,
      content: request,
      status: 'queued',
    });
    return { scene, version };
  }

  const job = (sceneId: string, versionId: string) => ({ sceneId, versionId });
  const versionOf = (id: string) =>
    dataSource.manager.findOneByOrFail(TemplateSceneVersion, { id });
  const sceneOf = (id: string) => dataSource.manager.findOneByOrFail(TemplateScene, { id });
  const messagesOf = (sceneId: string) =>
    dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId },
      order: { createdAt: 'ASC' },
    });

  /** Provedor controlado: devolve o resultado ou lança o erro, e registra as chamadas. */
  function fakeProvider(behavior: (input: SceneGenerateInput) => Promise<SceneGenerateResult>) {
    const generate = jest.fn(behavior);
    return { provider: { name: 'mock', generate } as SceneImageProvider, generate };
  }
  const okResult = async (costUsd: number | null = 0.1365): Promise<SceneGenerateResult> => ({
    buffer: await sharp({ create: { width: 1920, height: 3840, channels: 3, background: '#468' } })
      .png()
      .toBuffer(),
    usage: null,
    costUsd,
    requestId: 'req_1',
    latencyMs: 1234,
  });

  it('sucesso: gera master PNG 1920x3840 e prévia WebP de 1024 px, versão ready e resposta no chat', async () => {
    const { scene, version } = await queuedScene('campo verde com sol à direita');

    await processorWith(mock()).process(job(scene.id, version.id), 'job-1');

    const done = await versionOf(version.id);
    expect(done).toMatchObject({
      status: 'ready',
      step: 'done',
      errorCode: null,
      providerCostUsd: 0,
    });
    const master = await dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: done.masterAssetId as string,
    });
    const preview = await dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: done.previewAssetId as string,
    });
    expect(master).toMatchObject({ role: 'master', width: 1920, height: 3840 });
    expect(preview).toMatchObject({ role: 'preview', height: 1024 });
    expect(master.url).toBe(`/uploads/template-scenes/${scene.id}/${version.id}/master.png`);
    const masterMeta = await sharp(files.absolutePath(master.url)).metadata();
    const previewMeta = await sharp(files.absolutePath(preview.url)).metadata();
    expect(masterMeta).toMatchObject({ format: 'png', width: 1920, height: 3840 });
    expect(previewMeta).toMatchObject({ format: 'webp', height: 1024, width: 512 });
    const stored = await sceneOf(scene.id);
    expect(stored.currentVersionId).toBe(version.id);
    expect(stored.revision).toBeGreaterThan(0);
    const messages = await messagesOf(scene.id);
    expect(messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done'],
    ]);
  });

  it('manda ao provedor o tamanho nativo, o modelo, a qualidade e o prompt com o pedido', async () => {
    const { provider, generate } = fakeProvider(() => okResult());
    const { scene, version } = await queuedScene('pedido literal do cliente');

    await processorWith(provider, { TEMPLATE_SCENE_IMAGE_MODEL: 'gpt-image-2.5-sunburst' }).process(
      job(scene.id, version.id),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0][0];
    expect(input).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      size: '1920x3840',
      quality: 'high',
      correlationId: (await versionOf(version.id)).correlationId,
    });
    expect(input.prompt).toContain('"pedido literal do cliente"');
    expect(input.prompt).toContain('sem texto legível');
  });

  it('grava a tentativa pendente ANTES da chamada paga e o custo do usage depois', async () => {
    let seenDuringCall: TemplateSceneVersion | null = null;
    const { provider } = fakeProvider(async () => {
      seenDuringCall = await versionOf(version.id);
      return okResult(0.1365);
    });
    const { scene, version } = await queuedScene('custo');

    await processorWith(provider).process(job(scene.id, version.id));

    expect(seenDuringCall).toMatchObject({ status: 'running', step: 'generating' });
    expect((seenDuringCall as unknown as TemplateSceneVersion).metrics.calls).toEqual([
      expect.objectContaining({ kind: 'generate', status: 'pending', size: '1920x3840' }),
    ]);
    const done = await versionOf(version.id);
    expect(done.metrics.calls).toEqual([
      expect.objectContaining({ status: 'done', costUsd: 0.1365, requestId: 'req_1' }),
    ]);
    expect(done.providerCostUsd).toBe(0.1365);
    expect(done.latencyMs).toBe(1234);
    expect((await sceneOf(scene.id)).totalCostUsd).toBe(0.1365);
  });

  it.each([
    ['PROVIDER_QUOTA', 'sem saldo'],
    ['PROVIDER_CONTENT_POLICY', 'Descreva a cena de outro jeito'],
    ['PROVIDER_TIMEOUT', 'demorou demais'],
    ['PROVIDER_ERROR', 'Tente de novo'],
  ] as const)(
    'falha %s: versão failed com mensagem em pt-BR, uma só requisição, sem lançar',
    async (code, trecho) => {
      const { provider, generate } = fakeProvider(async () => {
        throw new SceneProviderError(code, 'falha simulada');
      });
      const { scene, version } = await queuedScene(`falha ${code}`);

      await expect(
        processorWith(provider).process(job(scene.id, version.id)),
      ).resolves.toBeUndefined();

      expect(generate).toHaveBeenCalledTimes(1);
      expect(await versionOf(version.id)).toMatchObject({
        status: 'failed',
        errorCode: code,
        providerCostUsd: 0,
      });
      const messages = await messagesOf(scene.id);
      expect(messages[1]).toMatchObject({ role: 'assistant', status: 'failed' });
      expect(messages[1].content).toContain(trecho);
      expect((await sceneOf(scene.id)).currentVersionId).toBeNull();
    },
  );

  it('quota registra log de erro com sceneId e correlationId', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { provider } = fakeProvider(async () => {
      throw new SceneProviderError('PROVIDER_QUOTA', 'sem saldo');
    });
    const { scene, version } = await queuedScene('quota log');

    await processorWith(provider).process(job(scene.id, version.id));

    const correlationId = (await versionOf(version.id)).correlationId;
    const logged = error.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('PROVIDER_QUOTA'));
    expect(logged).toContain(scene.id);
    expect(logged).toContain(correlationId);
    error.mockRestore();
  });

  it('erro inesperado do provedor (não classificado) vira PROVIDER_ERROR', async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error('socket hang up');
    });
    const { scene, version } = await queuedScene('erro inesperado');
    await processorWith(provider).process(job(scene.id, version.id));
    expect(await versionOf(version.id)).toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_ERROR',
    });
  });

  it('marcadores do mock: #falha-quota e #falha-conteudo chegam ao fim do fluxo', async () => {
    const quota = await queuedScene('campo #falha-quota');
    await processorWith(mock()).process(job(quota.scene.id, quota.version.id));
    expect((await versionOf(quota.version.id)).errorCode).toBe('PROVIDER_QUOTA');
    const content = await queuedScene('campo #falha-conteudo');
    await processorWith(mock()).process(job(content.scene.id, content.version.id));
    expect((await versionOf(content.version.id)).errorCode).toBe('PROVIDER_CONTENT_POLICY');
  });

  it('cancelamento durante a chamada: resultado descartado, custo gravado, versão cancelled', async () => {
    const { scene, version } = await queuedScene('cancela durante');
    const { provider } = fakeProvider(async () => {
      // o usuário clica em "Cancelar" enquanto a chamada paga está em curso
      await dataSource.manager.update(
        TemplateSceneVersion,
        { id: version.id },
        { cancelRequestedAt: new Date() },
      );
      return okResult(0.12);
    });
    const before = await sceneOf(scene.id);

    await processorWith(provider).process(job(scene.id, version.id));

    const done = await versionOf(version.id);
    expect(done).toMatchObject({ status: 'cancelled', providerCostUsd: 0.12, masterAssetId: null });
    expect(done.metrics.calls).toEqual([
      expect.objectContaining({ status: 'done', costUsd: 0.12 }),
    ]);
    const stored = await sceneOf(scene.id);
    expect(stored.totalCostUsd).toBe(0.12);
    expect(stored.currentVersionId).toBe(before.currentVersionId);
    expect(await dataSource.manager.countBy(TemplateSceneAsset, { sceneId: scene.id })).toBe(0);
    await expect(fs.access(path.join(uploadsDir, 'template-scenes', scene.id))).rejects.toThrow();
    const messages = await messagesOf(scene.id);
    expect(messages[1].content).toBe('Geração cancelada.');
  });

  it('cancelamento pedido antes de o worker pegar: cancela sem chamar o provedor', async () => {
    const { provider, generate } = fakeProvider(() => okResult());
    const { scene, version } = await queuedScene('cancela antes', {
      cancelRequestedAt: new Date(),
    });
    await processorWith(provider).process(job(scene.id, version.id));
    expect(generate).not.toHaveBeenCalled();
    expect(await versionOf(version.id)).toMatchObject({ status: 'cancelled', providerCostUsd: 0 });
  });

  it('cena excluída durante a chamada: resultado descartado e custo gravado', async () => {
    const { scene, version } = await queuedScene('excluída durante');
    const { provider } = fakeProvider(async () => {
      await dataSource.manager.softDelete(TemplateScene, { id: scene.id });
      return okResult(0.05);
    });

    await processorWith(provider).process(job(scene.id, version.id));

    expect(await versionOf(version.id)).toMatchObject({
      status: 'cancelled',
      providerCostUsd: 0.05,
    });
    expect(await dataSource.manager.countBy(TemplateSceneAsset, { sceneId: scene.id })).toBe(0);
  });

  it.each(['ready', 'failed', 'cancelled', 'running'] as const)(
    'job repetido com a versão %s: sai sem chamar o provedor e sem mudar o custo',
    async (status) => {
      const { provider, generate } = fakeProvider(() => okResult());
      const { scene, version } = await queuedScene(`repetido ${status}`, {
        status,
        providerCostUsd: 0.2,
      });
      await dataSource.manager.update(TemplateScene, { id: scene.id }, { totalCostUsd: 0.2 });

      await processorWith(provider).process(job(scene.id, version.id), 'job-repetido');

      expect(generate).not.toHaveBeenCalled();
      expect((await versionOf(version.id)).providerCostUsd).toBe(0.2);
      expect((await sceneOf(scene.id)).totalCostUsd).toBe(0.2);
    },
  );

  it('entregar o mesmo job duas vezes depois do sucesso chama o provedor uma vez só', async () => {
    const { provider, generate } = fakeProvider(() => okResult(0.1));
    const { scene, version } = await queuedScene('duas entregas');
    const processor = processorWith(provider);

    await processor.process(job(scene.id, version.id), 'job-1');
    await processor.process(job(scene.id, version.id), 'job-1');

    expect(generate).toHaveBeenCalledTimes(1);
    expect((await versionOf(version.id)).providerCostUsd).toBe(0.1);
  });

  it('versão ou cena inexistente: sai em silêncio', async () => {
    const { provider, generate } = fakeProvider(() => okResult());
    const { scene } = await queuedScene('inexistente');
    await expect(
      processorWith(provider).process(job(scene.id, '00000000-0000-4000-8000-000000000000')),
    ).resolves.toBeUndefined();
    await expect(
      processorWith(provider).process(
        job('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001'),
      ),
    ).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('disjuntor: já com 4 chamadas pagas na versão, falha PAID_CALL_LIMIT sem chamar o provedor', async () => {
    const { provider, generate } = fakeProvider(() => okResult());
    const calls = Array.from({ length: 4 }, (_, i) => ({
      id: `c${i}`,
      kind: 'generate' as const,
      status: 'done' as const,
      model: 'm',
      size: '1x1',
      startedAt: new Date().toISOString(),
    }));
    const { scene, version } = await queuedScene('disjuntor', { metrics: { calls } });

    await processorWith(provider).process(job(scene.id, version.id));

    expect(generate).not.toHaveBeenCalled();
    expect(await versionOf(version.id)).toMatchObject({
      status: 'failed',
      errorCode: 'PAID_CALL_LIMIT',
    });
  });

  it('o limite do disjuntor vem de TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE', async () => {
    const { provider, generate } = fakeProvider(() => okResult());
    const call = {
      id: 'c',
      kind: 'generate' as const,
      status: 'done' as const,
      model: 'm',
      size: '1x1',
      startedAt: 'x',
    };
    const { scene, version } = await queuedScene('disjuntor env', { metrics: { calls: [call] } });
    await processorWith(provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' }).process(
      job(scene.id, version.id),
    );
    expect(generate).not.toHaveBeenCalled();
    expect((await versionOf(version.id)).errorCode).toBe('PAID_CALL_LIMIT');
  });

  it('erro depois da chamada paga (imagem inválida): failed com o custo gravado e sem lançar', async () => {
    const { provider } = fakeProvider(async () => ({
      ...(await okResult(0.1)),
      buffer: Buffer.from('lixo'),
    }));
    const { scene, version } = await queuedScene('imagem inválida');

    await expect(
      processorWith(provider).process(job(scene.id, version.id)),
    ).resolves.toBeUndefined();

    expect(await versionOf(version.id)).toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_ERROR',
      providerCostUsd: 0.1,
    });
    expect((await sceneOf(scene.id)).totalCostUsd).toBe(0.1);
    expect(await dataSource.manager.countBy(TemplateSceneAsset, { sceneId: scene.id })).toBe(0);
  });

  it('ao ficar ready, poda a master mais antiga (conjunto protegido de 5)', async () => {
    const scene = await insertScene(dataSource, { name: 'Processor poda' });
    createdScenes.push(scene.id);
    const ready = [];
    for (let n = 1; n <= 5; n++) ready.push(await insertReadyVersion(dataSource, scene, n));
    const version = await insertVersion(dataSource, scene.id, { number: 6, status: 'queued' });
    await insertMessage(dataSource, scene.id, { versionId: version.id, content: 'poda' });

    await processorWith(mock()).process(job(scene.id, version.id));

    const oldest = await dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: ready[0].master.id,
    });
    const newest = await dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: ready[4].master.id,
    });
    expect(oldest.expiresAt).not.toBeNull();
    expect(newest.expiresAt).toBeNull();
  });

  it('publica o evento da etapa e do fim por pg_notify', async () => {
    const received: Array<{
      sceneId: string;
      kind: string;
      step: string | null;
      revision: number;
    }> = [];
    const client = new Client({ connectionString: SCENE_DB_URL });
    await client.connect();
    await client.query('LISTEN template_scene_events');
    client.on('notification', (message) => {
      if (message.payload) received.push(JSON.parse(message.payload));
    });
    try {
      const { scene, version } = await queuedScene('eventos');

      await processorWith(mock()).process(job(scene.id, version.id));
      await new Promise((resolve) => setTimeout(resolve, 300));

      const mine = received.filter((event) => event.sceneId === scene.id);
      expect(mine.map((event) => event.kind)).toEqual([
        'version.step',
        'version.step',
        'version.step',
        'version.ready',
      ]);
      expect(mine.map((event) => event.step)).toEqual([
        'preparing',
        'generating',
        'saving',
        'done',
      ]);
      expect(mine[3].revision).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
