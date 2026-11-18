import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  createPayload,
  countByKey,
  createdAtText,
  DocumentBody,
  envelope,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocument } from '../testing/flyer-pro-documents.fixture';

/**
 * e2e do N1 (change 08-add-flyer-pro-document-api) sobre o harness da 05: guard JWT, pipe global, filtro e SQL reais. As bordas
 * de campo ficam no spec do DTO. O banco é compartilhado: cada lista é filtrada por um cliente da suíte.
 */
describeIfE2eDb('POST /v1/flyer-pro/documents: criar e recusar (e2e)', () => {
  const { h, url, clientA, fixture, create, open, list, newClient } = useDocumentsE2e({
    scenes: true,
  });
  const sc = () => fixture().scenes;

  describe('criar (N1)', () => {
    it('201 com o estado de recém-criado: cena de frente e verso 27x40, autor, cursor e cópia do template', async () => {
      const response = await create(h.seed.scenes.frontBack.id);

      expect(response.status).toBe(201);
      const { success, data } = envelope<DocumentBody>(response);
      expect(success).toBe(true);
      expect(data).toMatchObject({
        name: 'Ofertas Piccin semana 47',
        format: '27x40',
        pageCount: 1,
        pagesFrozen: false,
        step: 'products',
        revision: 0,
        lastMutationId: null,
        layoutDigest: null,
        renderDigest: null,
        layoutSnapshot: null,
        ui: {},
        items: [],
        enrichment: null,
        replayed: false,
        slices: { frame: {}, structure: {}, card: {}, assembly: {}, exportPrefs: {} },
        templateStatus: {
          available: true,
          usable: true,
          missingFaces: [],
          stale: false,
          staleKind: null,
        },
        createdByUserId: h.seed.user.id,
        updatedByUserId: h.seed.user.id,
      });
      expect(data.templateSnapshot.layout).toBe('front_back');
      expect(data.templateSnapshot.faces.map((face) => face.key)).toEqual(['front', 'back']);
      expect(data.createdAt).toBe(data.updatedAt);
      expect(data.itemsCursor).toBe(await createdAtText(h.dataSource, data.id));
    });

    it('cena de jornal 54x40 nasce com 2 páginas; o nome é aparado e as versões ficam como vieram', async () => {
      const response = await create(h.seed.scenes.tabloid.id, {
        name: '  Feira de sábado  ',
        engineVersion: 3,
      });

      expect(response.status).toBe(201);
      expect(envelope<DocumentBody>(response).data).toMatchObject({
        format: '54x40',
        pageCount: 2,
        name: 'Feira de sábado',
        schemaVersion: 1,
        engineVersion: 3,
      });
    });

    it('o criado é o primeiro da lista do cliente e abre igual, sem replayed', async () => {
      const clientId = await newClient();
      await insertDocument(h.dataSource, { clientId, updatedAt: new Date('2026-01-01T10:00:00Z') });
      const created = envelope<DocumentBody>(
        await create(h.seed.scenes.frontBack.id, {}, clientId),
      ).data;

      const listed = await list(`clientId=${clientId}`);
      const { replayed, ...creation } = created;

      expect(listed.data[0].id).toBe(created.id);
      expect(replayed).toBe(false);
      expect(await open(created.id)).toEqual(creation);
    });

    it('sem token é 401 e nada é criado', async () => {
      const key = randomUUID();
      const response = await h
        .http()
        .post(`/v1${url}`)
        .send(
          createPayload(
            { clientId: clientA(), sceneId: h.seed.scenes.frontBack.id },
            { creationKey: key },
          ),
        );

      expect(response.status).toBe(401);
      expect(envelope<null>(response).error?.code).toBe('UNAUTHORIZED');
      expect(await countByKey(h.dataSource, key)).toBe(0);
    });

    it.each([
      ['corpo vazio', {}, /Campos obrigatórios ausentes: creationKey, name, clientId/],
      ['pageCount, que só o servidor grava', { pageCount: 2 }, /pageCount/],
    ])('400 BAD_REQUEST com %s, sem criar nada', async (_name, extra, message) => {
      const key = randomUUID();
      const body =
        Object.keys(extra).length === 0
          ? {}
          : createPayload(
              { clientId: clientA(), sceneId: h.seed.scenes.frontBack.id },
              { creationKey: key, ...extra },
            );

      const response = await h.post(url, body);

      expect(response.status).toBe(400);
      const { error } = envelope<null>(response);
      expect(error?.code).toBe('BAD_REQUEST');
      expect(JSON.stringify(error)).toMatch(message);
      expect(await countByKey(h.dataSource, key)).toBe(0);
    });
  });

  describe('recusas de cliente e template na criação', () => {
    const missing = randomUUID();
    type Refusal = {
      name: string;
      ids: () => { clientId: string; sceneId: string };
      status: number;
      code: string;
      details: unknown;
    };
    const anyDetails = expect.anything();
    const front = () => h.seed.scenes.frontBack.id;
    const cases: Refusal[] = [
      {
        name: 'cliente inexistente',
        ids: () => ({ clientId: missing, sceneId: front() }),
        status: 404,
        code: 'CLIENT_NOT_FOUND',
        details: anyDetails,
      },
      {
        name: 'cliente e cena inexistentes',
        ids: () => ({ clientId: missing, sceneId: randomUUID() }),
        status: 404,
        code: 'CLIENT_NOT_FOUND',
        details: anyDetails,
      },
      {
        name: 'cena inexistente',
        ids: () => ({ clientId: clientA(), sceneId: randomUUID() }),
        status: 404,
        code: 'FLYER_PRO_TEMPLATE_NOT_FOUND',
        details: anyDetails,
      },
      {
        name: 'formato fora (20x27)',
        ids: () => ({ clientId: clientA(), sceneId: sc().single20.id }),
        status: 422,
        code: 'FLYER_PRO_TEMPLATE_UNSUPPORTED',
        details: expect.objectContaining({ reason: 'FORMAT', layout: 'single' }),
      },
      {
        name: '54x40 de face única',
        ids: () => ({ clientId: clientA(), sceneId: sc().single54.id }),
        status: 422,
        code: 'FLYER_PRO_TEMPLATE_UNSUPPORTED',
        details: expect.objectContaining({ reason: 'LAYOUT' }),
      },
      {
        name: 'frente e verso com só a Frente pronta',
        ids: () => ({ clientId: clientA(), sceneId: sc().frontOnly.id }),
        status: 422,
        code: 'FLYER_PRO_TEMPLATE_INCOMPLETE',
        details: { missingFaces: ['back'] },
      },
    ];

    it.each(cases)('$name: recusa sem criar nada e sem gastar a chave', async (refusal) => {
      const key = randomUUID();

      const response = await h.post(url, createPayload(refusal.ids(), { creationKey: key }));

      expect(response.status).toBe(refusal.status);
      expect(envelope<null>(response).error).toMatchObject({
        code: refusal.code,
        details: refusal.details,
      });
      expect(await countByKey(h.dataSource, key)).toBe(0);
      const retry = await h.post(
        url,
        createPayload({ clientId: clientA(), sceneId: front() }, { creationKey: key }),
      );
      expect(retry.status).toBe(201);
    });
  });
});
