import { AnimationEventsService } from '../../shared/events/animation-events.service';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

type Scene = Record<string, any>;

/**
 * E2E da cena de frente e verso (fluxo base): criar, frente, "Fazer o verso", ajuste e voltar no verso, os dois
 * templates em `GET /v1/templates` e excluir. Provedor de imagem e Diretor `mock`, fila e worker reais no mesmo
 * processo. Rodar com `TEMPLATE_SCENE_E2E_DB_URL=... npm run test -- template-scenes.faces.e2e --runInBand`.
 */
describeIfSceneDb('Cena de frente e verso (e2e, banco chroma_x_e2e)', () => {
  const h = useE2eHarness();
  const { http, authed, get, post, waitForScene } = h;

  const faceReady = (key: 'front' | 'back') => (scene: Scene) => {
    const face = scene.faces?.find((item: Scene) => item.key === key);
    return face?.currentVersion?.status === 'ready';
  };
  const faceOf = (scene: Scene, key: 'front' | 'back') =>
    scene.faces.find((item: Scene) => item.key === key);
  const idle = (scene: Scene) => scene.activeVersion === null;

  const listTemplates = (search: string) =>
    authed(http().get('/v1/templates').query({ search, type: 'full', limit: 50 }));

  it('de ponta a ponta: frente, verso pelo botão, ajuste e volta no verso, dois templates e exclusão', async () => {
    const created = await post('', {
      name: 'E2E São João',
      formatId: 'folheto-27x40',
      layout: 'front_back',
    });
    expect(created.status).toBe(201);
    const sceneId = created.body.data.id as string;
    h.trackScene(sceneId);
    const events: Scene[] = [];
    const unsubscribe = h.harness.app
      .get(AnimationEventsService)
      .subscribeScene(sceneId, (event: Scene) => events.push(event));
    expect(created.body.data).toMatchObject({
      layout: 'front_back',
      widthPx: 2352,
      heightPx: 3504,
    });
    expect(created.body.data.faces.map((face: Scene) => face.key)).toEqual(['front', 'back']);

    // a frente nasce como a cena de uma face
    const sent = await post(`/${sceneId}/messages`, {
      content: 'campo verde com sol à direita',
      expectedRevision: 0,
    });
    expect(sent.status).toBe(202);
    const withFront = await waitForScene(
      sceneId,
      (scene) => faceReady('front')(scene) && idle(scene),
    );
    expect(faceOf(withFront, 'back').currentVersion).toBeNull();
    expect(withFront.currentVersion.id).toBe(faceOf(withFront, 'front').currentVersion.id);

    // fazer o verso pelo botão
    const derived = await post(`/${sceneId}/faces/back/derive`, {
      expectedRevision: withFront.revision,
    });
    expect(derived.status).toBe(202);
    expect(derived.body.data).toMatchObject({
      messageId: expect.any(String),
      versionId: expect.any(String),
      jobId: expect.any(String),
    });
    const withBack = await waitForScene(
      sceneId,
      (scene) => faceReady('back')(scene) && idle(scene),
    );
    const back = faceOf(withBack, 'back').currentVersion;
    expect(back).toMatchObject({ operation: 'derive_face', faceKey: 'back', displayNumber: 1 });
    expect(withBack.currentVersion.id).toBe(faceOf(withBack, 'front').currentVersion.id);
    const derivedMessage = withBack.messages.find(
      (message: Scene) => message.content === 'Fazer o verso',
    );
    expect(derivedMessage).toMatchObject({ role: 'user', faceKey: 'back' });
    // o verso já existe: o botão responde 409 e nenhuma chamada paga é feita
    const again = await post(`/${sceneId}/faces/back/derive`, {
      expectedRevision: withBack.revision,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BACK_ALREADY_EXISTS');

    // ajuste no verso
    const adjust = await post(`/${sceneId}/messages`, {
      content: 'coloca bandeirinhas discretas no topo',
      expectedRevision: withBack.revision,
      face: 'back',
    });
    expect(adjust.status).toBe(202);
    const adjusted = await waitForScene(
      sceneId,
      (scene) => idle(scene) && faceOf(scene, 'back').currentVersion?.operation === 'redraw',
    );
    expect(faceOf(adjusted, 'front').currentVersion.id).toBe(withBack.currentVersion.id);
    expect(faceOf(adjusted, 'back').currentVersion).toMatchObject({ displayNumber: 2 });

    // voltar no verso: a imagem da versão 1 dele, sem chamada de imagem
    const undo = await post(`/${sceneId}/messages`, {
      content: 'volta como estava antes',
      expectedRevision: adjusted.revision,
      face: 'back',
    });
    expect(undo.status).toBe(202);
    const undone = await waitForScene(
      sceneId,
      (scene) => idle(scene) && faceOf(scene, 'back').currentVersion?.operation === 'restore',
    );
    expect(faceOf(undone, 'back').currentVersion.master.url).toBe(back.master.url);
    expect(faceOf(undone, 'front').currentVersion.id).toBe(withBack.currentVersion.id);
    const backPage = await get(`/${sceneId}?face=back`);
    expect(backPage.body.data.versions.items.every((v: Scene) => v.faceKey === 'back')).toBe(true);

    // os dois templates, pela fila do worker (o job espera 5 s: aqui roda direto)
    await h.harness.templateSync.process({ sceneId });
    const templates = await listTemplates('E2E São João');
    expect(templates.status).toBe(200);
    expect(templates.body.data.map((template: Scene) => template.name).sort()).toEqual([
      'E2E São João — Frente',
      'E2E São João — Verso',
    ]);

    // os eventos de versão trazem a face: a tela troca de aba quando o verso é derivado pelo chat
    unsubscribe();
    const readyKeys = events
      .filter((event) => event.kind === 'version.ready')
      .map((e) => e.faceKey);
    expect(readyKeys[0]).toBe('front');
    expect(readyKeys).toContain('back');
    expect(events.every((event) => ['front', 'back'].includes(event.faceKey))).toBe(true);
    expect(events.find((event) => event.versionId === derived.body.data.versionId)?.faceKey).toBe(
      'back',
    );

    // excluir: os dois saem
    const removed = await authed(http().delete(`/v1/template-scenes/${sceneId}`));
    expect(removed.status).toBe(204);
    expect((await listTemplates('E2E São João')).body.data).toEqual([]);
  });

  it('a cena de uma face do fluxo atual segue igual: uma face, sem verso, e o botão responde 422', async () => {
    const created = await post('', { name: 'E2E Uma face', formatId: 'folheto-27x54' });
    expect(created.status).toBe(201);
    const sceneId = created.body.data.id as string;
    h.trackScene(sceneId);
    expect(created.body.data).toMatchObject({ layout: 'single' });
    expect(created.body.data.faces).toHaveLength(1);

    await post(`/${sceneId}/messages`, { content: 'campo verde', expectedRevision: 0 });
    const ready = await waitForScene(sceneId, h.isReady);
    expect(ready.currentVersion).toMatchObject({ faceKey: 'single', operation: 'generate' });

    const derive = await post(`/${sceneId}/faces/back/derive`, {
      expectedRevision: ready.revision,
    });
    expect(derive.status).toBe(422);
    expect(derive.body.error.code).toBe('FACE_NOT_FOUND');
  });

  it('frente e verso num formato em paisagem: 422 SCENE_LAYOUT_UNSUPPORTED', async () => {
    const response = await post('', {
      name: 'E2E Paisagem',
      formatId: 'folheto-55x36',
      layout: 'front_back',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('SCENE_LAYOUT_UNSUPPORTED');
  });

  it('acesso negado: sem token, a rota do verso responde 401', async () => {
    const response = await http()
      .post('/v1/template-scenes/00000000-0000-4000-8000-000000000000/faces/back/derive')
      .send({ expectedRevision: 0 });
    expect(response.status).toBe(401);
  });
});
