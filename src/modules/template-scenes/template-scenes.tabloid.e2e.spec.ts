import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

type Scene = Record<string, any>;

/**
 * E2E do jornal de 4 páginas (fluxo base): criar, Externa, cabeçalho maior, "Fazer a interna", ajuste e volta na
 * Interna, volta na Externa trazendo a altura do cabeçalho, os dois templates em `GET /v1/templates` e excluir.
 * Provedor de imagem e Diretor `mock`, fila e worker reais no mesmo processo. Rodar com
 * `TEMPLATE_SCENE_E2E_DB_URL=... npm run test -- template-scenes.tabloid.e2e --runInBand`.
 */
describeIfSceneDb('Jornal de 4 páginas (e2e, banco chroma_x_e2e)', () => {
  const h = useE2eHarness();
  const { http, authed, get, post, waitForScene } = h;

  const faceOf = (scene: Scene, key: 'outer' | 'inner') =>
    scene.faces.find((item: Scene) => item.key === key);
  const idle = (scene: Scene) => scene.activeVersion === null;
  const listTemplates = (search: string) =>
    authed(http().get('/v1/templates').query({ search, type: 'full', limit: 50 }));

  it('de ponta a ponta: externa, cabeçalho maior, interna pelo botão, ajuste e volta, dois templates e exclusão', async () => {
    const created = await post('', {
      name: 'E2E Jornal',
      formatId: 'folheto-54x40',
      layout: 'tabloid',
    });
    expect(created.status).toBe(201);
    const sceneId = created.body.data.id as string;
    h.trackScene(sceneId);
    expect(created.body.data).toMatchObject({ layout: 'tabloid', widthPx: 3328, heightPx: 2480 });
    expect(created.body.data.faces.map((face: Scene) => face.key)).toEqual(['outer', 'inner']);
    expect(faceOf(created.body.data, 'outer').zones.header.h).toBeCloseTo(0.15, 10);
    expect(faceOf(created.body.data, 'inner').zones.fold).toEqual(
      faceOf(created.body.data, 'outer').zones.fold,
    );

    // a Externa nasce pela primeira mensagem
    const sent = await post(`/${sceneId}/messages`, {
      content: 'jornal de aniversário, festivo, vermelho e dourado',
      expectedRevision: 0,
      face: 'outer',
    });
    expect(sent.status).toBe(202);
    const withOuter = await waitForScene(
      sceneId,
      (scene) => faceOf(scene, 'outer').currentVersion?.status === 'ready' && idle(scene),
    );
    expect(faceOf(withOuter, 'inner').currentVersion).toBeNull();
    const firstOuter = faceOf(withOuter, 'outer').currentVersion;

    // cabeçalho maior: 8 cm (h 0,2), pela edição de imagem
    const bigger = await post(`/${sceneId}/messages`, {
      content: 'deixa o cabeçalho maior',
      expectedRevision: withOuter.revision,
      face: 'outer',
    });
    expect(bigger.status).toBe(202);
    const resized = await waitForScene(
      sceneId,
      (scene) => idle(scene) && faceOf(scene, 'outer').currentVersion?.id !== firstOuter.id,
    );
    expect(faceOf(resized, 'outer').zones.header.h).toBeCloseTo(0.2, 10);

    // Fazer a interna pelo botão
    const derived = await post(`/${sceneId}/faces/inner/derive`, {
      expectedRevision: resized.revision,
    });
    expect(derived.status).toBe(202);
    const withInner = await waitForScene(
      sceneId,
      (scene) => faceOf(scene, 'inner').currentVersion?.status === 'ready' && idle(scene),
    );
    const inner = faceOf(withInner, 'inner').currentVersion;
    expect(inner).toMatchObject({ operation: 'derive_face', faceKey: 'inner', displayNumber: 1 });
    const again = await post(`/${sceneId}/faces/inner/derive`, {
      expectedRevision: withInner.revision,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('BACK_ALREADY_EXISTS');

    // ajuste e volta na Interna
    const adjust = await post(`/${sceneId}/messages`, {
      content: 'deixa o fundo mais claro',
      expectedRevision: withInner.revision,
      face: 'inner',
    });
    expect(adjust.status).toBe(202);
    const adjusted = await waitForScene(
      sceneId,
      (scene) => idle(scene) && faceOf(scene, 'inner').currentVersion?.operation === 'redraw',
    );
    const undo = await post(`/${sceneId}/messages`, {
      content: 'volta como estava antes',
      expectedRevision: adjusted.revision,
      face: 'inner',
    });
    expect(undo.status).toBe(202);
    const undone = await waitForScene(
      sceneId,
      (scene) => idle(scene) && faceOf(scene, 'inner').currentVersion?.operation === 'restore',
    );
    expect(faceOf(undone, 'inner').currentVersion.master.url).toBe(inner.master.url);

    // voltar na Externa traz a altura do cabeçalho junto
    const back = await post(`/${sceneId}/messages`, {
      content: 'volta como estava antes',
      expectedRevision: undone.revision,
      face: 'outer',
    });
    expect(back.status).toBe(202);
    const restored = await waitForScene(
      sceneId,
      (scene) => idle(scene) && faceOf(scene, 'outer').currentVersion?.operation === 'restore',
    );
    expect(faceOf(restored, 'outer').zones.header.h).toBeCloseTo(0.15, 10);

    // os dois templates, com a dobra como dado
    await h.harness.templateSync.process({ sceneId });
    const templates = await listTemplates('E2E Jornal');
    expect(templates.status).toBe(200);
    expect(templates.body.data.map((template: Scene) => template.name).sort()).toEqual([
      'E2E Jornal — Externa',
      'E2E Jornal — Interna',
    ]);
    const outerTemplate = templates.body.data.find((t: Scene) => t.name.endsWith('Externa'));
    expect(outerTemplate.configuration.source).toMatchObject({
      faceKey: 'outer',
      fold: { xPx: 1664, safeFromPx: 1574, safeToPx: 1754 },
    });

    // excluir: os dois saem
    const removed = await authed(http().delete(`/v1/template-scenes/${sceneId}`));
    expect(removed.status).toBe(204);
    expect((await listTemplates('E2E Jornal')).body.data).toEqual([]);
    expect((await get(`/${sceneId}`)).status).toBe(404);
  });

  it('acesso negado: sem token, a rota da interna responde 401', async () => {
    const response = await http()
      .post('/v1/template-scenes/00000000-0000-4000-8000-000000000000/faces/inner/derive')
      .send({ expectedRevision: 0 });
    expect(response.status).toBe(401);
  });
});
