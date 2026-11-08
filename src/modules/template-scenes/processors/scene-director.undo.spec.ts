import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('Desfazer sem chamar o modelo de imagem (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();

  /** Cena com as versões 1, 2 e 3 (cada uma com imagem própria), a 3 atual. */
  async function sceneWithThree() {
    const first = await h.readyScene();
    const v2 = await h.readyVersionLike(first.scene, 2, first.version.id);
    const v3 = await h.readyVersionLike(first.scene, 3, v2.version.id);
    first.scene.currentVersionId = v3.version.id;
    await h.dataSource.manager.save(first.scene);
    return { scene: first.scene, v1: first.version, v2: v2.version, v3: v3.version };
  }

  async function ask(sceneId: string, message: string, undo_target: 'previous' | number | null) {
    const sent = await h.post(sceneId, message);
    const { client, plan } = h.directorClient(async () =>
      directorAnswer(directorPlan({ turn_kind: 'desfazer', reply: 'Vou voltar.', undo_target })),
    );
    await h.directorProcessor(client).process({ sceneId, versionId: sent.versionId });
    const versions = await h.dataSource.manager.find(TemplateSceneVersion, {
      where: { sceneId },
      order: { number: 'ASC' },
    });
    const assistant = (
      await h.dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId, role: 'assistant' },
        order: { createdAt: 'ASC' },
      })
    ).pop();
    return {
      sent,
      versions,
      plan,
      reply: assistant?.content,
      version: await h.versionOf(sent.versionId),
    };
  }
  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);

  it('Voltar: a versão de leitura vira a restauração com a imagem da 2, sem segunda versão e sem custo de imagem', async () => {
    const { scene, v2, v3 } = await sceneWithThree();
    const costBefore = (await h.sceneOf(scene.id)).totalCostUsd;

    const { versions, version, reply, sent } = await ask(
      scene.id,
      'volta como estava antes',
      'previous',
    );

    expect(versions).toHaveLength(4);
    expect(version).toMatchObject({
      id: sent.versionId,
      operation: 'restore',
      status: 'ready',
      step: 'done',
      parentVersionId: v2.id,
      masterAssetId: v2.masterAssetId,
      previewAssetId: v2.previewAssetId,
    });
    expect(version.masterAssetId).not.toBe(v3.masterAssetId);
    const stored = await h.sceneOf(scene.id);
    expect(stored.currentVersionId).toBe(sent.versionId);
    expect(reply).toBe('Voltei para a imagem da versão 2. Ela agora é a versão 4.');
    expect(imageJobs()).toHaveLength(0);
    // só o custo do Diretor entrou na conta: nenhuma chamada de imagem
    expect(stored.totalCostUsd - costBefore).toBeCloseTo(0.000435, 6);
    expect(version.metrics.calls).toBeUndefined();
  });

  it('Voltar duas vezes: o segundo "volta" cria a versão com a imagem da 1, e não a mesma imagem da 2', async () => {
    const { scene, v1, v2 } = await sceneWithThree();
    const first = await ask(scene.id, 'volta', 'previous');
    expect(first.version.masterAssetId).toBe(v2.masterAssetId);

    const second = await ask(scene.id, 'volta de novo', 'previous');

    expect(second.version).toMatchObject({
      operation: 'restore',
      status: 'ready',
      parentVersionId: v1.id,
    });
    expect(second.version.masterAssetId).toBe(v1.masterAssetId);
    expect(second.reply).toBe('Voltei para a imagem da versão 1. Ela agora é a versão 5.');
    expect(second.versions).toHaveLength(5);
  });

  it('Já na primeira imagem: o chat diz que essa já é a primeira, a leitura fica rejected e nada com imagem nasce', async () => {
    const { scene, version: v1 } = await h.readyScene();
    const result = await ask(scene.id, 'volta', 'previous');
    expect(result.version).toMatchObject({ status: 'rejected', masterAssetId: null });
    expect(result.reply).toContain('Essa já é a primeira imagem');
    expect(result.versions).toHaveLength(2);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(v1.id);
  });

  it('Versão citada: "volta para a versão 3" cria uma versão com a imagem da 3', async () => {
    const { scene, v3, v2 } = await sceneWithThree();
    // vai para a 2 e depois cita a 3
    await ask(scene.id, 'volta', 'previous');
    const result = await ask(scene.id, 'volta para a versão 3', 3);
    expect(result.version).toMatchObject({
      operation: 'restore',
      status: 'ready',
      parentVersionId: v3.id,
    });
    expect(result.version.masterAssetId).toBe(v3.masterAssetId);
    expect(result.version.masterAssetId).not.toBe(v2.masterAssetId);
    expect(result.reply).toBe('Voltei para a imagem da versão 3. Ela agora é a versão 5.');
  });

  it('Versão inexistente: o chat diz que não existe e cita as disponíveis, sem versão com imagem', async () => {
    const { scene } = await sceneWithThree();
    const result = await ask(scene.id, 'volta para a versão 9', 9);
    expect(result.version.status).toBe('rejected');
    expect(result.reply).toBe('Não existe a versão 9. Disponíveis: 1, 2, 3. Nada foi alterado.');
    expect(result.versions).toHaveLength(4);
  });

  it('a versão citada já é a atual: o chat diz, e nada muda', async () => {
    const { scene } = await sceneWithThree();
    const result = await ask(scene.id, 'volta para a versão 3', 3);
    expect(result.version.status).toBe('rejected');
    expect(result.reply).toBe('A versão 3 já é a atual. Nada foi alterado.');
  });

  it('Master já apagada: o chat diz que não está disponível e cita as disponíveis', async () => {
    const { scene, v2 } = await sceneWithThree();
    await h.dataSource.manager.update(
      TemplateSceneAsset,
      { id: v2.masterAssetId as string },
      { purgedAt: new Date() },
    );

    const result = await ask(scene.id, 'volta', 'previous');

    expect(result.version).toMatchObject({ status: 'rejected', masterAssetId: null });
    expect(result.reply).toContain('Essa imagem não está mais disponível');
    expect(result.reply).toContain('Disponíveis: 1, 3.');
    expect(result.versions).toHaveLength(4);
    expect((await h.sceneOf(scene.id)).currentVersionId).not.toBe(result.sent.versionId);
  });

  it('a restauração pelo REST continua com lock, revisão e SCENE_BUSY (mesmo trecho, restoreInto)', async () => {
    const { scene, v1 } = await sceneWithThree();
    const sent = await h.post(scene.id, 'tira o coelho');
    // versão de leitura queued: o REST dá SCENE_BUSY, e o consumer, que usa restoreInto, não
    const { SceneVersionsService } = await import('../services/scene-versions.service');
    const { SceneLockService } = await import('../services/scene-lock.service');
    const { SceneReadService } = await import('../services/scene-read.service');
    const versions = new SceneVersionsService(
      h.dataSource,
      new SceneLockService(h.dataSource),
      new SceneReadService(h.dataSource),
    );
    await expect(versions.restore(scene.id, v1.id, null)).rejects.toMatchObject({
      response: { code: 'SCENE_BUSY' },
    });
    expect(sent.versionId).toBeDefined();
  });
});
