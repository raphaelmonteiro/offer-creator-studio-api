import { SCENE_IMAGE_PROVIDER } from './providers/scene-image-provider';
import { MockSceneImageProvider } from './providers/mock-scene-image.provider';
import { jpeg } from './testing/scene-reference-harness';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

type Scene = Record<string, any>;

/**
 * E2E da cena a partir de um encarte (fluxo base): flag desligada e acesso negado, criar, enviar, ficha, corrigir,
 * gerar, tentar de novo, editar, imagem nova sem referência e o jornal com a Externa por encarte e "Fazer a interna".
 * Provedor de imagem, visão e Diretor `mock` (sem chamada paga), fila e worker reais no mesmo processo. Rodar com
 * `TEMPLATE_SCENE_E2E_DB_URL=... npm run test -- template-scenes.reference.e2e --runInBand`.
 */
describeIfSceneDb('Cena a partir de um encarte (e2e, banco chroma_x_e2e)', () => {
  const h = useE2eHarness();
  const { http, authed, get, post, waitForScene } = h;

  const provider = () => h.harness.app.get(SCENE_IMAGE_PROVIDER) as MockSceneImageProvider;
  const upload = async (sceneId: string, revision: number, file?: Buffer, name = 'junina.jpg') =>
    authed(
      http()
        .post(`/v1/template-scenes/${sceneId}/reference`)
        .field('expectedRevision', String(revision))
        .attach('file', file ?? (await jpeg(1200, 1800)), {
          filename: name,
          contentType: 'image/jpeg',
        }),
    );
  const settled = (state: string) => (scene: Scene) =>
    scene.activeVersion === null && scene.reference?.state === state;
  const idleWith = (count: number) => (scene: Scene) =>
    scene.activeVersion === null && scene.versions.total === count;
  const promptOf = async (versionId: string): Promise<string> =>
    (
      await h.dataSource.query(
        `SELECT metrics->>'prompt' AS prompt FROM template_scene_versions WHERE id = $1`,
        [versionId],
      )
    )[0].prompt;

  beforeAll(() => {
    delete process.env.TEMPLATE_SCENE_REFERENCE_ENABLED;
  });

  it('flag da referência desligada: 404 REFERENCE_DISABLED nas três rotas; sem login, 401', async () => {
    const scene = await h.newScene('E2E Ref flag', 'folheto-27x40');
    const off = await upload(scene.id, 0);
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('REFERENCE_DISABLED');
    for (const route of ['revise', 'generate']) {
      const response = await post(`/${scene.id}/reference/${route}`, {
        expectedRevision: 0,
        note: 'x',
      });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('REFERENCE_DISABLED');
    }
    expect(((await get(`/${scene.id}`)).body.data as Scene).reference).toBeNull();
    const anonymous = await http()
      .post(`/v1/template-scenes/${scene.id}/reference/generate`)
      .send({ expectedRevision: 0 });
    expect(anonymous.status).toBe(401);
  });

  it('de ponta a ponta: ficha, correção, gerar, tentar de novo, edição e imagem nova sem referência', async () => {
    process.env.TEMPLATE_SCENE_REFERENCE_ENABLED = 'true';
    const scene = await h.newScene('E2E Referência', 'folheto-27x40');

    const pdf = await authed(
      http()
        .post(`/v1/template-scenes/${scene.id}/reference`)
        .field('expectedRevision', '0')
        .attach('file', Buffer.from('%PDF-1.4'), {
          filename: 'e.pdf',
          contentType: 'application/pdf',
        }),
    );
    expect(pdf.status).toBe(422);
    expect(pdf.body.error.code).toBe('REFERENCE_INVALID');

    const sent = await upload(scene.id, 0);
    expect(sent.status).toBe(202);
    const proposed = await waitForScene(scene.id, settled('proposed'));
    expect(proposed.reference).toMatchObject({
      fileName: 'junina.jpg',
      revisionsLeft: 5,
      canRetry: false,
      summary: {
        theme: 'festa junina',
        leftOut: expect.arrayContaining(['o selo/medalhão da logo']),
      },
    });
    expect(proposed.reference.previewUrl).toMatch(/reference-.*\.jpg$/);
    expect(proposed.versions.total).toBe(0);
    expect(proposed.currentVersion).toBeNull();
    const reply = proposed.messages.at(-1);
    expect(reply).toMatchObject({ role: 'assistant' });
    expect(reply.content).toContain('Posso gerar assim?');

    const revised = await post(`/${scene.id}/reference/revise`, {
      expectedRevision: proposed.revision,
      note: 'não tem bandeirinha, tira',
    });
    expect(revised.status).toBe(202);
    const corrected = await waitForScene(
      scene.id,
      (data) => settled('proposed')(data) && data.reference.revisionsLeft === 4,
    );
    expect(corrected.reference.summary.uses.join(' ')).not.toContain('bandeirinhas');

    const generated = await post(`/${scene.id}/reference/generate`, {
      expectedRevision: corrected.revision,
    });
    expect(generated.status).toBe(202);
    const first = await waitForScene(scene.id, idleWith(1));
    expect(first.reference).toMatchObject({ state: 'used', canRetry: true });
    expect(first.currentVersion.operation).toBe('generate');
    expect(provider().edits.at(-1)?.prompt).toContain('strictly confined to the top 526 px');
    expect(await promptOf(first.currentVersion.id)).toContain('never pure white');

    const retry = await post(`/${scene.id}/reference/generate`, {
      expectedRevision: first.revision,
    });
    expect(retry.status).toBe(202);
    const second = await waitForScene(scene.id, idleWith(2));
    expect(second.currentVersion.id).not.toBe(first.currentVersion.id);

    const edit = await post(`/${scene.id}/messages`, {
      content: 'deixa as bandeirinhas maiores',
      expectedRevision: second.revision,
    });
    expect(edit.status).toBe(202);
    const edited = await waitForScene(scene.id, idleWith(3));
    expect(edited.reference.canRetry).toBe(false);
    const edits = provider().edits.length;
    const denied = await post(`/${scene.id}/reference/generate`, {
      expectedRevision: edited.revision,
    });
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe('REFERENCE_NOT_PROPOSED');
    const late = await upload(scene.id, edited.revision);
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('REFERENCE_ONLY_AT_START');

    const fresh = await post(`/${scene.id}/messages`, {
      content: 'gere outra imagem',
      expectedRevision: edited.revision,
    });
    expect(fresh.status).toBe(202);
    const regenerated = await waitForScene(scene.id, idleWith(4));
    expect(regenerated.currentVersion.operation).toBe('generate');
    expect(provider().edits.length).toBe(edits); // imagem nova: generate, sem o encarte
    expect(await promptOf(regenerated.currentVersion.id)).not.toContain('reference image');
  });

  it('jornal: a Externa nasce do encarte e a Interna sai pelo botão, sem o encarte; GET /v1/templates lista os dois', async () => {
    process.env.TEMPLATE_SCENE_REFERENCE_ENABLED = 'true';
    const created = await post('', {
      name: 'E2E Ref Jornal',
      formatId: 'folheto-54x40',
      layout: 'tabloid',
    });
    const sceneId = created.body.data.id as string;
    h.trackScene(sceneId);
    expect((await upload(sceneId, 0)).status).toBe(202);
    const proposed = await waitForScene(sceneId, settled('proposed'));
    expect(proposed.faces.every((face: Scene) => face.currentVersion === null)).toBe(true);

    const generated = await post(`/${sceneId}/reference/generate`, {
      expectedRevision: proposed.revision,
    });
    expect(generated.status).toBe(202);
    const outer = await waitForScene(
      sceneId,
      (scene) => scene.activeVersion === null && scene.faces[0].currentVersion?.status === 'ready',
    );
    expect(outer.faces[1].currentVersion).toBeNull();
    expect(provider().edits.at(-1)?.prompt).toContain('Art concept from the reference flyer');

    const derived = await post(`/${sceneId}/faces/inner/derive`, {
      expectedRevision: outer.revision,
    });
    expect(derived.status).toBe(202);
    const both = await waitForScene(
      sceneId,
      (scene) => scene.activeVersion === null && scene.faces[1].currentVersion?.status === 'ready',
    );
    expect(provider().edits.at(-1)?.prompt).toContain('INNER side');
    expect(provider().edits.at(-1)?.prompt).not.toContain('Art concept');
    expect(both.reference.state).toBe('used');

    await h.harness.templateSync.process({ sceneId });
    const templates = await authed(
      http().get('/v1/templates').query({ search: 'E2E Ref Jornal', type: 'full', limit: 50 }),
    );
    expect(templates.body.data.map((template: Scene) => template.name).sort()).toEqual([
      'E2E Ref Jornal — Externa',
      'E2E Ref Jornal — Interna',
    ]);
  });
});
