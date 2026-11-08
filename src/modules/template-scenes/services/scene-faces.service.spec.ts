import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { useFacesHarness } from '../testing/scene-faces-harness';
import { insertVersion } from '../testing/scene-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorOf } from '../testing/scene-test-helpers';
import { SceneFacesService } from './scene-faces.service';
import { SceneLockService } from './scene-lock.service';

describeIfSceneDb('Fazer o verso pelo botão (banco chroma_x_e2e)', () => {
  const h = useFacesHarness();

  /** O serviço com a fila falsa do harness: o job do verso fica registrado em `h.queue.publish`. */
  const service = () =>
    new SceneFacesService(
      h.dataSource,
      new SceneLockService(h.dataSource),
      h.queue as unknown as ConstructorParameters<typeof SceneFacesService>[2],
    );
  const derive = (sceneId: string, revision?: number) =>
    service().deriveBack(sceneId, revision ?? 0, null);
  const versionsOf = (sceneId: string) =>
    h.dataSource.manager.find(TemplateSceneVersion, {
      where: { sceneId },
      order: { number: 'ASC' },
    });
  const jobs = () =>
    h.queue.publish.mock.calls.filter(([name]) => name === QUEUES.TEMPLATE_SCENE_TURN);

  it('Fazer o verso pelo botão: 202 com a mensagem, a versão e o job; sem chamar o Diretor', async () => {
    const { scene, front } = await h.frontBackScene({ front: true });
    const revision = (await h.sceneOf(scene.id)).revision;

    const result = await derive(scene.id, revision);

    expect(result).toMatchObject({ revision: revision + 1 });
    const version = await h.versionOf(result.versionId);
    expect(version).toMatchObject({
      faceIndex: 1,
      operation: 'derive_face',
      status: 'queued',
      step: null,
      parentVersionId: null,
      derivedFromVersionId: front?.id,
      elements: [],
    });
    const message = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
      id: result.messageId,
    });
    expect(message).toMatchObject({
      role: 'user',
      content: 'Fazer o verso',
      faceIndex: 1,
      versionId: result.versionId,
      status: 'queued',
    });
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0][1]).toMatchObject({ sceneId: scene.id, versionId: result.versionId });
    const directorJobs = h.queue.publish.mock.calls.filter(
      ([name]) => name === QUEUES.TEMPLATE_SCENE_DIRECTOR,
    );
    expect(directorJobs).toHaveLength(0);
    expect((await h.sceneOf(scene.id)).revision).toBe(revision + 1);
  });

  it('Frente sem imagem: 422 FRONT_NOT_READY e nenhum job', async () => {
    const { scene } = await h.frontBackScene();

    const result = await errorOf(derive(scene.id));

    expect(result).toEqual({ status: 422, code: 'FRONT_NOT_READY' });
    expect(jobs()).toHaveLength(0);
    expect(await versionsOf(scene.id)).toHaveLength(0);
  });

  it('Frente com a versão atual que falhou (sem imagem): 422 FRONT_NOT_READY', async () => {
    const { scene } = await h.frontBackScene();
    const failed = await insertVersion(h.dataSource, scene.id, { number: 1, status: 'failed' });
    await h.dataSource.manager.query(
      `UPDATE template_scene_faces SET "currentVersionId" = $1 WHERE "sceneId" = $2 AND "index" = 0`,
      [failed.id, scene.id],
    );

    expect(await errorOf(derive(scene.id))).toEqual({ status: 422, code: 'FRONT_NOT_READY' });
  });

  it('Verso já existe: 409 BACK_ALREADY_EXISTS e nenhuma chamada paga', async () => {
    const { scene } = await h.frontBackScene({ front: true, back: true });

    const result = await errorOf(derive(scene.id));

    expect(result).toEqual({ status: 409, code: 'BACK_ALREADY_EXISTS' });
    expect(jobs()).toHaveLength(0);
    expect(await versionsOf(scene.id)).toHaveLength(2);
  });

  it('Cena de uma face: 422 FACE_NOT_FOUND e nada é gravado', async () => {
    const { scene } = await h.readyScene();

    const result = await errorOf(derive(scene.id));

    expect(result).toEqual({ status: 422, code: 'FACE_NOT_FOUND' });
    expect(jobs()).toHaveLength(0);
    expect(await versionsOf(scene.id)).toHaveLength(1);
  });

  it('Cena ocupada: 409 SCENE_BUSY quando a frente está em curso', async () => {
    const { scene } = await h.frontBackScene({ front: true });
    await insertVersion(h.dataSource, scene.id, { number: 2, status: 'running' });

    const result = await errorOf(derive(scene.id));

    expect(result).toEqual({ status: 409, code: 'SCENE_BUSY' });
    expect(jobs()).toHaveLength(0);
  });

  it('revisão antiga: 409 REVISION_CONFLICT antes de qualquer outra conferência', async () => {
    const { scene } = await h.frontBackScene({ front: true });
    await h.dataSource.query(`UPDATE template_scenes SET revision = 4 WHERE id = $1`, [scene.id]);

    expect(await errorOf(derive(scene.id, 3))).toEqual({ status: 409, code: 'REVISION_CONFLICT' });
  });

  it('Clique duplo: uma requisição recebe 202, a outra 409, e existe uma só versão do verso', async () => {
    const { scene } = await h.frontBackScene({ front: true });
    const revision = (await h.sceneOf(scene.id)).revision;

    const outcomes = await Promise.allSettled([
      derive(scene.id, revision),
      derive(scene.id, revision),
    ]);

    const ok = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const rejection = (failed[0] as PromiseRejectedResult).reason as {
      getStatus(): number;
      getResponse(): { code: string };
    };
    expect(rejection.getStatus()).toBe(409);
    expect(['REVISION_CONFLICT', 'SCENE_BUSY']).toContain(rejection.getResponse().code);
    const backVersions = (await versionsOf(scene.id)).filter((version) => version.faceIndex === 1);
    expect(backVersions).toHaveLength(1);
    expect(jobs()).toHaveLength(1);
  });
});
