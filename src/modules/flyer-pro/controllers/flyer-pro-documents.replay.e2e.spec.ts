import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  countByKey,
  createPayload,
  DocumentBody,
  envelope,
  rowOf,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import {
  insertDocument,
  insertDocumentWithItems,
  updateDocumentRow,
} from '../testing/flyer-pro-documents.fixture';
import { countItems } from '../testing/flyer-pro-documents.e2e.testutil';

/**
 * e2e da idempotência do N1 e do N6 (change 08-add-flyer-pro-document-api) sobre o harness da 05, com o guard, o pipe e o SQL
 * reais: a repetição da chave (inclusive a corrida), a chave de encarte excluído e a exclusão lógica.
 */
describeIfE2eDb(
  'POST e DELETE /v1/flyer-pro/documents: repetição pela chave e exclusão (e2e)',
  () => {
    const { h, url, clientA, asBruno, noToken, create, list, newClient, open } = useDocumentsE2e({
      scenes: true,
    });

    describe('criação idempotente pela chave', () => {
      it('o mesmo pedido responde 200 com o mesmo id e uma linha só; com outro nome e outra cena devolve o original', async () => {
        const first = envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
        const key = (await rowOf(h.dataSource, first.id))['creationKey'] as string;

        const same = await h.post(
          url,
          createPayload(
            { clientId: clientA(), sceneId: h.seed.scenes.frontBack.id },
            { creationKey: key },
          ),
        );
        const other = await h.post(
          url,
          createPayload(
            { clientId: clientA(), sceneId: h.seed.scenes.tabloid.id },
            { creationKey: key, name: 'Outro nome' },
          ),
        );

        for (const response of [same, other]) {
          expect(response.status).toBe(200);
          expect(envelope<DocumentBody>(response).data).toMatchObject({
            id: first.id,
            replayed: true,
            name: first.name,
            sceneId: first.sceneId,
            revision: 0,
            updatedAt: first.updatedAt,
            templateSnapshot: first.templateSnapshot,
          });
        }
        expect(await countByKey(h.dataSource, key)).toBe(1);
      });

      it('depois de gravações a repetição devolve o estado atual (revision 3 e o nome gravado)', async () => {
        const first = envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
        const key = (await rowOf(h.dataSource, first.id))['creationKey'] as string;
        await updateDocumentRow(h.dataSource, first.id, { revision: 3, name: 'Ofertas da semana' });

        const again = await h.post(
          url,
          createPayload({ clientId: clientA(), sceneId: first.sceneId }, { creationKey: key }),
        );

        expect(again.status).toBe(200);
        expect(envelope<DocumentBody>(again).data).toMatchObject({
          replayed: true,
          revision: 3,
          name: 'Ofertas da semana',
        });
      });

      it('a repetição com campo desconhecido é 400 e o encarte não muda', async () => {
        const first = envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
        const key = (await rowOf(h.dataSource, first.id))['creationKey'] as string;

        const again = await h.post(
          url,
          createPayload(
            { clientId: clientA(), sceneId: first.sceneId },
            { creationKey: key, format: '54x40' },
          ),
        );

        expect(again.status).toBe(400);
        const { replayed: _replayed, ...stored } = first;
        expect(await open(first.id)).toEqual(stored);
      });

      it('dois pedidos ao mesmo tempo: um 201 e um 200, o mesmo id e uma linha só', async () => {
        const body = createPayload({ clientId: clientA(), sceneId: h.seed.scenes.frontBack.id });

        const responses = await Promise.all([h.post(url, body), h.post(url, body)]);

        expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
        const [a, b] = responses.map((response) => envelope<DocumentBody>(response).data);
        expect(a.id).toBe(b.id);
        expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
        expect(await countByKey(h.dataSource, body.creationKey)).toBe(1);
      });

      it('chave de encarte excluído é 404 e não restaura; com outra chave o mesmo pedido cria', async () => {
        const first = envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
        const key = (await rowOf(h.dataSource, first.id))['creationKey'] as string;
        await h.delete(`${url}/${first.id}`);
        const before = await rowOf(h.dataSource, first.id);

        const refused = await h.post(
          url,
          createPayload({ clientId: clientA(), sceneId: first.sceneId }, { creationKey: key }),
        );
        const fresh = await create(first.sceneId);

        expect(refused.status).toBe(404);
        expect(envelope<null>(refused).error?.code).toBe('FLYER_PRO_NOT_FOUND');
        expect(await rowOf(h.dataSource, first.id)).toEqual(before);
        expect(await countByKey(h.dataSource, key)).toBe(1);
        expect(fresh.status).toBe(201);
        expect(envelope<DocumentBody>(fresh).data.id).not.toBe(first.id);
      });
    });

    describe('id inexistente ou excluído', () => {
      it('404 FLYER_PRO_NOT_FOUND na abertura e na exclusão, e 401 antes de olhar o id sem token', async () => {
        const gone = await insertDocument(h.dataSource, {
          clientId: clientA(),
          deletedAt: new Date(),
        });
        for (const id of [randomUUID(), gone]) {
          for (const response of [await h.get(`${url}/${id}`), await h.delete(`${url}/${id}`)]) {
            expect(response.status).toBe(404);
            expect(envelope<null>(response).error).toMatchObject({
              code: 'FLYER_PRO_NOT_FOUND',
              message: 'Encarte não encontrado ou excluído.',
            });
          }
        }
        const unauthorized = await noToken(`${url}/abc`);
        expect(unauthorized.status).toBe(401);
        expect(envelope<null>(unauthorized).error?.code).toBe('UNAUTHORIZED');
      });
    });

    describe('excluir (N6)', () => {
      it('200 com { deleted: true }, sai da lista e da abertura, mantém os itens e não muda revisão nem autor', async () => {
        const clientId = await newClient();
        const { id } = await insertDocumentWithItems(
          h.dataSource,
          { clientId, updatedByUserId: h.seed.user.id },
          3,
        );
        await updateDocumentRow(h.dataSource, id, { revision: 4 });
        const before = await rowOf(h.dataSource, id);

        const response = await h.delete(`${url}/${id}`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, data: { deleted: true } });
        expect((await list(`clientId=${clientId}`)).data).toEqual([]);
        expect((await h.get(`${url}/${id}`)).status).toBe(404);
        expect(await countItems(h.dataSource, id)).toBe(3);
        const after = await rowOf(h.dataSource, id);
        expect(after['deletedAt']).not.toBeNull();
        expect({ ...after, deletedAt: null }).toEqual(before);
        expect((await h.delete(`${url}/${id}`)).status).toBe(404);
      });

      it('dois pedidos ao mesmo tempo: um 200 e um 404; outro usuário também exclui', async () => {
        const clientId = await newClient();
        const id = await insertDocument(h.dataSource, { clientId });
        const other = await insertDocument(h.dataSource, { clientId });

        const responses = await Promise.all([h.delete(`${url}/${id}`), h.delete(`${url}/${id}`)]);
        const byBruno = await h.http().delete(`/v1${url}/${other}`).set(asBruno());

        expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
        expect(byBruno.status).toBe(200);
      });

      it('sem token é 401 e o encarte não muda', async () => {
        const id = await insertDocument(h.dataSource, { clientId: clientA() });
        const before = await rowOf(h.dataSource, id);

        const response = await h.http().delete(`/v1${url}/${id}`);

        expect(response.status).toBe(401);
        expect(await rowOf(h.dataSource, id)).toEqual(before);
      });
    });
  },
);
