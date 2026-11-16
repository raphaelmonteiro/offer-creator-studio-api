import { overrideEnv } from '../../../shared/testing/e2e-app';
import { useE2eHarness } from '../../../shared/testing/e2e-harness';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { TemplateSceneEnabledGuard } from '../../template-scenes/template-scene-enabled.guard';
import { FlyerProModule } from '../flyer-pro.module';
import { createFlyerProFixture, FlyerProFixture } from '../testing/flyer-pro-scene-fixture';
import {
  ENTRY_CASES,
  Entry,
  e2eDataSourceModule,
  entryOf,
  listAll,
  suiteIds,
  templateRowOf,
  writeMarks,
} from '../testing/flyer-pro-templates.e2e.testutil';

/**
 * e2e da N7 `GET /v1/flyer-pro/templates` (change 07-add-flyer-pro-templates-api) sobre o harness da 05, com a flag das
 * cenas desligada. O banco é compartilhado (A-3): a ordem e as buscas são conferidas pelos ids da suíte.
 */
describeIfE2eDb('GET /v1/flyer-pro/templates (e2e)', () => {
  const restoreFlag = overrideEnv({ TEMPLATE_SCENE_ENABLED: 'false' });
  afterAll(() => restoreFlag());
  const h = useE2eHarness({
    imports: [e2eDataSourceModule(() => h.dataSource), FlyerProModule],
  });
  let fixture: FlyerProFixture;
  let sc: FlyerProFixture['scenes'];
  let suite: string[];
  const get = (url: string) => h.get(url);
  const ids = (...scenes: Array<{ id: string }>) => scenes.map((scene) => scene.id);
  const found = async (query: string) => suiteIds(await listAll(get, query), suite);
  const encoded = (term: string) => encodeURIComponent(term);

  beforeAll(async () => {
    fixture = await createFlyerProFixture(h.dataSource, {
      uploadsDir: h.uploadsDir,
      cdnUrl: h.app.config.get<string>('CDN_URL') as string,
    });
    h.onCleanup(() => fixture.cleanup());
    sc = fixture.scenes;
    suite = Object.values(sc).map((scene) => scene.id);
  }, 240_000);

  describe('inclusão, usable e formato', () => {
    it('lista só as cenas que cumprem as regras, com o envelope', async () => {
      const response = await get(`/flyer-pro/templates?search=${fixture.suffix}&limit=50`);
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      const listed = ids(
        sc.single1,
        sc.single2,
        sc.tabloid3,
        sc.tabloid4,
        sc.frontBack5,
        sc.frontOnly,
        sc.frontDeleted,
        sc.outerOnly,
        sc.cover10,
        sc.layers,
        sc.single54,
        sc.reserve,
        sc.pascoa,
        sc.fiftyPercent,
        sc.abaco,
        sc.beta,
        sc.gamaA,
        sc.gamaB,
      );
      expect(suiteIds(response.body.data, suite).sort()).toEqual(listed.sort());
      expect(response.body.pagination).toEqual({ page: 1, limit: 50, total: 18, totalPages: 1 });
    });

    it.each(['single54Empty', 'unmarked', 'dangling', 'single20', 'deleted'] as const)(
      'a cena %s não entra: 200 com data vazio pelo sceneId',
      async (role) => {
        const response = await get(`/flyer-pro/templates?sceneId=${sc[role].id}`);
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
      },
    );

    it.each(ENTRY_CASES)(
      '%s: o que a lista diz da cena (usable, motivo, faltando, formato, páginas) e as faces prontas',
      async (role, expected, faces) => {
        const entry = await entryOf(get, sc[role].id);
        expect(entry).toEqual(
          expect.objectContaining({
            sceneId: sc[role].id,
            name: sc[role].name,
            layout: sc[role].layout,
            ...expected,
          }),
        );
        expect(entry.faces.map((face) => face.key)).toEqual(faces);
      },
    );

    it('face 0 pela reserva da cena: o templateId da face é o approvedTemplateId', async () => {
      const [scene] = await h.dataSource.query(
        `SELECT "approvedTemplateId" FROM template_scenes WHERE id = $1`,
        [sc.reserve.id],
      );
      expect((await entryOf(get, sc.reserve.id)).faces[0].templateId).toBe(
        scene.approvedTemplateId,
      );
    });
  });

  describe('campos, URLs, zonas, faixas e camadas', () => {
    it('frente e verso: os campos da cena e da face são os gravados, sem a configuração', async () => {
      const entry = await entryOf(get, sc.frontBack5.id);
      const [scene] = await h.dataSource.query(
        `SELECT revision, "updatedAt" FROM template_scenes WHERE id = $1`,
        [sc.frontBack5.id],
      );
      expect(entry.sceneRevision).toBe(scene.revision);
      expect(entry.updatedAt).toBe(scene.updatedAt.toISOString());
      expect(entry.thumbnailUrl).toBe(entry.faces[0].thumbnailUrl);
      expect(entry.faces.map((f) => [f.key, f.index, f.label, f.widthPx, f.heightPx])).toEqual([
        ['front', 0, 'Frente', 2352, 3504],
        ['back', 1, 'Verso', 2352, 3504],
      ]);
      for (const face of entry.faces) {
        const row = await templateRowOf(h.dataSource, face.templateId);
        const { source, bodyBackground } = row.configuration;
        expect(face.artUrl).toBe(bodyBackground.imageUrl);
        expect(face.artUrl).toMatch(/^http:\/\/cdn\.e2e\.test\/uploads\/templates\/scene-/);
        expect(face.thumbnailUrl).toBe(row.thumbnailUrl);
        expect([face.pictorialKey, face.fingerprint, face.syncedAt]).toEqual([
          source.pictorialKey,
          source.fingerprint,
          source.syncedAt,
        ]);
      }
      expect(JSON.stringify(entry)).not.toMatch(/"(configuration|bodyBackground|source)"/);
    });

    it.each([
      ['single1', { header: 15, footer: 90, width: 27.5, headerCm: 6.15 }],
      ['tabloid3', { header: 15, footer: 90, width: 55, headerCm: 6.15 }],
      ['cover10', { header: 25, footer: 90, width: 55, headerCm: 10.25 }],
    ] as const)('%s: zonas e faixas da primeira face pela projeção', async (role, expected) => {
      const face = (await entryOf(get, sc[role].id)).faces[0];
      expect(face.zones).toEqual({
        header: { from: 0, to: expected.header },
        footer: { from: expected.footer, to: 100 },
      });
      const band = (heightCm: number) =>
        expect.objectContaining({ widthCm: expected.width, heightCm, elements: [] });
      expect(face.header).toEqual(band(expected.headerCm));
      expect(face.footer).toEqual(band(4.1));
    });

    it('as zonas guardadas na face da cena (15%) não valem: a capa de 10 cm sai com 25', async () => {
      const [row] = await h.dataSource.query(
        `SELECT zones FROM template_scene_faces WHERE "sceneId" = $1 AND key = 'outer'`,
        [sc.cover10.id],
      );
      expect(row.zones.header.h).toBeCloseTo(0.15, 4);
      expect((await entryOf(get, sc.cover10.id)).faces[0].zones.header).toEqual({
        from: 0,
        to: 25,
      });
    });

    it('as camadas de logo e de texto chegam como o template as grava', async () => {
      const face = (await entryOf(get, sc.layers.id)).faces[0];
      const { configuration } = await templateRowOf(h.dataSource, face.templateId);
      expect(face.header?.elements).toEqual(configuration.header.elements);
      expect(face.footer?.elements).toEqual(configuration.footer.elements);
      expect(face.header?.elements).toEqual([
        expect.objectContaining({ type: 'image', id: 'logo-1' }),
      ]);
      expect(face.footer?.elements).toEqual([
        expect.objectContaining({
          type: 'text',
          content: 'Ofertas da semana',
          fontFamily: 'Georgia',
        }),
      ]);
    });

    it('as cenas da semente: zonas vazias onde a face não tem a zona, faixas nulas e sem camadas', async () => {
      const [front, back] = (await entryOf(get, h.seed.scenes.frontBack.id)).faces;
      expect([front.zones.footer, back.zones.header]).toEqual([
        { from: 100, to: 100 },
        { from: 0, to: 0 },
      ]);
      expect([front.footer, back.header]).toEqual([null, null]);
      expect([front.header?.elements, back.footer?.elements]).toEqual([[], []]);
      const [outer, inner] = (await entryOf(get, h.seed.scenes.tabloid.id)).faces;
      expect(inner.zones).toEqual({ header: { from: 0, to: 0 }, footer: { from: 100, to: 100 } });
      expect([inner.header, inner.footer]).toEqual([null, null]);
      expect([outer.header?.widthCm, outer.footer?.widthCm]).toEqual([55, 55]);
    });
  });

  describe('filtros, busca, ordem e paginação', () => {
    it.each([
      ['folheto 5 (contém, e não o "5- folheto")', 'folheto 5', ['tabloid3', 'tabloid4']],
      ['5-', '5-', ['frontBack5']],
      ['FOLHETO', 'FOLHETO', ['single1', 'single2', 'tabloid3', 'tabloid4', 'frontBack5']],
      ['pascoa', 'pascoa', ['pascoa']],
      ['PÁSCOA', 'PÁSCOA', ['pascoa']],
      ['50%', '50%', ['fiftyPercent']],
    ] as const)('busca %s', async (_name, term, roles) => {
      const result = await found(`search=${encoded(term)}`);
      expect(result.sort()).toEqual(ids(...roles.map((role) => sc[role])).sort());
    });

    it('o _ vale como texto: só vem cena cujo nome tem _', async () => {
      const entries = await listAll(get, 'search=_');
      expect(entries.every((entry) => entry.name.includes('_'))).toBe(true);
      expect(suiteIds(entries, suite)).toEqual([]);
    });

    it('format filtra por formato e combina com a busca', async () => {
      const only54 = await found(`format=54x40&search=${fixture.suffix}`);
      expect(only54.sort()).toEqual(
        ids(sc.tabloid3, sc.tabloid4, sc.outerOnly, sc.cover10, sc.single54).sort(),
      );
      const only27 = await found(`format=27x40&search=${fixture.suffix}`);
      expect(only27.filter((id) => only54.includes(id))).toEqual([]);
      expect(only27).toContain(sc.frontBack5.id);
    });

    it('sceneId traz só a cena, com total 1 mesmo com limit=1', async () => {
      const response = await get(`/flyer-pro/templates?sceneId=${sc.tabloid4.id}&limit=1`);
      expect(response.body.data.map((entry: Entry) => entry.sceneId)).toEqual([sc.tabloid4.id]);
      expect(response.body.pagination.total).toBe(1);
    });

    it.each([
      ['inexistente', '00000000-0000-4000-8000-000000000000', ''],
      ['de outro formato', 'frontBack5', '&format=54x40'],
    ])('sceneId %s: 200 com data vazio', async (_name, scene, extra) => {
      const sceneId = scene in sc ? sc[scene as keyof typeof sc].id : scene;
      const response = await get(`/flyer-pro/templates?sceneId=${sceneId}${extra}`);
      expect([response.status, response.body.data]).toEqual([200, []]);
    });

    it('ordena pelo nome sem acento e sem caixa e desempata pelo id', async () => {
      const order = await found(`search=${fixture.suffix}`);
      const [lowId, highId] = ids(sc.gamaA, sc.gamaB).sort();
      const expected = [sc.abaco.id, sc.beta.id, lowId, highId];
      expect(order.filter((id) => expected.includes(id))).toEqual(expected);
      const numbered = ids(sc.single1, sc.single2, sc.tabloid3, sc.tabloid4, sc.frontBack5);
      expect(order.filter((id) => numbered.includes(id))).toEqual(numbered);
    });

    it('página do meio, além do fim e valores padrão', async () => {
      const term = `search=${encoded(`x40 ${fixture.suffix}`)}`;
      const middle = await get(`/flyer-pro/templates?${term}&page=2&limit=2`);
      expect(middle.body.data.map((entry: Entry) => entry.sceneId)).toEqual(
        ids(sc.tabloid3, sc.tabloid4),
      );
      expect(middle.body.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
      const beyond = await get(`/flyer-pro/templates?${term}&page=9`);
      expect(beyond.status).toBe(200);
      expect(beyond.body.data).toEqual([]);
      expect(beyond.body.pagination).toEqual({ page: 9, limit: 20, total: 5, totalPages: 1 });
      const defaults = await get('/flyer-pro/templates');
      expect(defaults.body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 20 }));
    });
  });

  describe('consulta inválida, token, repetição e flag', () => {
    it.each([
      'limit=51',
      'limit=0',
      'page=0',
      'page=abc',
      'format=20x27',
      'sceneId=abc',
      `search=${'x'.repeat(81)}`,
      'foo=1',
    ])('%s: 400 BAD_REQUEST', async (query) => {
      const response = await get(`/flyer-pro/templates?${query}`);
      expect([response.status, response.body.error.code]).toEqual([400, 'BAD_REQUEST']);
    });

    it('sem token: 401 UNAUTHORIZED', async () => {
      const response = await h.http().get('/v1/flyer-pro/templates');
      expect(response.status).toBe(401);
      expect(response.body).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'UNAUTHORIZED' }),
        }),
      );
    });

    it('chamada repetida: a mesma resposta e nenhuma linha gravada', async () => {
      const marks = await writeMarks(h.dataSource, suite);
      const query = `/flyer-pro/templates?search=${fixture.suffix}&limit=50`;
      const [first, second] = [await get(query), await get(query)];
      expect(second.body).toEqual(first.body);
      expect(await writeMarks(h.dataSource, suite)).toEqual(marks);
    });

    it('com a flag das cenas desligada a lista responde, e o guard das cenas segue recusando', async () => {
      expect(() => new TemplateSceneEnabledGuard().canActivate()).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'TEMPLATE_SCENE_DISABLED' }),
        }),
      );
      for (const scene of [h.seed.scenes.frontBack, h.seed.scenes.tabloid]) {
        const response = await get(`/flyer-pro/templates?sceneId=${scene.id}`);
        expect(response.status).toBe(200);
        expect(response.body.data[0]).toEqual(
          expect.objectContaining({
            sceneId: scene.id,
            usable: true,
            unusableReason: null,
            missingFaces: [],
          }),
        );
      }
    });
  });
});
