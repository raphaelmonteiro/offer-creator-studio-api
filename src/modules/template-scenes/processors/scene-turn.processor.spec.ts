import { Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { Client } from 'pg';
import { SceneProviderError } from '../providers/scene-image-provider';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  insertMessage,
  insertReadyVersion,
  insertScene,
  insertVersion,
} from '../testing/scene-fixtures';
import { SCENE_DB_URL } from '../testing/scene-test-db';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { useProcessorHarness } from '../testing/scene-processor-harness';

describeIfSceneDb(
  'SceneTurnProcessor: geração, falhas, custo, poda e eventos (banco chroma_x_e2e)',
  () => {
    const h = useProcessorHarness();
    const {
      mock,
      processorWith,
      queuedScene,
      trackScene,
      job,
      versionOf,
      sceneOf,
      messagesOf,
      fakeProvider,
      okResult,
    } = h;
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
      const master = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: done.masterAssetId as string,
      });
      const preview = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: done.previewAssetId as string,
      });
      expect(master).toMatchObject({ role: 'master', width: 1920, height: 3840 });
      expect(preview).toMatchObject({ role: 'preview', height: 1024 });
      expect(master.url).toBe(`/uploads/template-scenes/${scene.id}/${version.id}/master.png`);
      const masterMeta = await sharp(h.files.absolutePath(master.url)).metadata();
      const previewMeta = await sharp(h.files.absolutePath(preview.url)).metadata();
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

      await processorWith(provider, {
        TEMPLATE_SCENE_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
      }).process(job(scene.id, version.id));

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
      expect(await h.dataSource.manager.countBy(TemplateSceneAsset, { sceneId: scene.id })).toBe(0);
    });

    it('ao ficar ready, poda a master mais antiga (conjunto protegido de 5)', async () => {
      const scene = await insertScene(h.dataSource, { name: 'Processor poda' });
      trackScene(scene.id);
      const ready = [];
      for (let n = 1; n <= 5; n++) ready.push(await insertReadyVersion(h.dataSource, scene, n));
      const version = await insertVersion(h.dataSource, scene.id, { number: 6, status: 'queued' });
      await insertMessage(h.dataSource, scene.id, { versionId: version.id, content: 'poda' });

      await processorWith(mock()).process(job(scene.id, version.id));

      const oldest = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
        id: ready[0].master.id,
      });
      const newest = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
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
  },
);
