import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  createPayload,
  DocumentBody,
  envelope,
  rowOf,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocumentWithItems, updateDocumentRow } from '../testing/flyer-pro-documents.fixture';
import { deleteFaceTemplate, redoScene } from '../testing/flyer-pro-scene-edits';

/**
 * e2e do N3 (change 08-add-flyer-pro-document-api) sobre o harness da 05: o estado gravado devolvido como está, os itens e o
 * cursor lidos do banco real, abrir não grava, e o estado da cópia do template quando a cena muda depois da criação.
 */
describeIfE2eDb('GET /v1/flyer-pro/documents/:id: abrir (e2e)', () => {
  const { h, url, clientA, fixture, asBruno, create, list, newClient, open } = useDocumentsE2e({
    scenes: true,
  });
  const sc = () => fixture().scenes;

  describe('abrir (N3)', () => {
    it('devolve o estado gravado campo a campo, as cinco fatias e os itens (ordem, EAN, campos)', async () => {
      const clientId = await newClient();
      const price = { kind: 'from_to', cents: 599, fromCents: 799 };
      const imported = { v: 1, row: 2, name: 'ABACATE', price };
      const review = { checkedAt: '2026-11-14T13:05:12.000Z', suggestion: null };
      const eans = [
        ['b', '7891000100103'],
        ['a', '7891000100104'],
        ['c', '78960046'],
        ['d', null],
      ] as const;
      const positions = [2, 0, 1, 1];
      const { id } = await insertDocumentWithItems(
        h.dataSource,
        { clientId, createdByUserId: h.seed.user.id, updatedByUserId: h.seed.user.id },
        eans.map(([suffix, ean], index) => ({
          id: `00000000-0000-4000-8000-00000000000${suffix}`,
          position: positions[index],
          ean,
          price,
          imported,
          imageReview: review,
          spellReview: review,
        })),
      );
      const stored = {
        step: 'assembly',
        pagesFrozen: true,
        revision: 37,
        lastMutationId: randomUUID(),
        ui: { assemblyZoom: 2, inspectorTab: 'card' },
        structure: { sections: [{ id: 'cat:Hortifruti', itemIds: [] }] },
        layoutDigest: 'a41b07c9e2d35f18',
        renderDigest: 'f3a91c07d2be4410',
        layoutSnapshot: { engineVersion: 1, level: 2 },
      };
      await updateDocumentRow(h.dataSource, id, stored);

      const response = await h.get(`${url}/${id}`);

      expect(response.status).toBe(200);
      const { data } = envelope<DocumentBody>(response);
      const { structure, ...columns } = stored;
      expect(data).toMatchObject({ ...columns, enrichment: null });
      expect(Object.keys(data.slices).sort()).toEqual([
        'assembly',
        'card',
        'exportPrefs',
        'frame',
        'structure',
      ]);
      expect(data.slices.structure).toEqual(structure);
      for (const absent of ['creationKey', 'deletedAt', 'replayed'])
        expect(data).not.toHaveProperty(absent);
      expect(data.items.map((item) => [item.position, item.id.slice(-1)])).toEqual([
        [0, 'a'],
        [1, 'c'],
        [1, 'd'],
        [2, 'b'],
      ]);
      expect(data.items.map((item) => item.eanValid)).toEqual([false, true, null, true]);
      expect(data.items[0]).toMatchObject({
        price,
        imported,
        imageReview: review,
        spellReview: review,
        importId: null,
      });
      expect(data.items[0]).not.toHaveProperty('documentId');
    });

    it('os itens são só os do encarte aberto, e o cursor guarda os microssegundos do banco', async () => {
      const clientId = await newClient();
      const other = await insertDocumentWithItems(h.dataSource, { clientId }, 2);
      const { id } = await insertDocumentWithItems(h.dataSource, { clientId }, [
        { updatedAtText: '2026-11-14 13:05:40.412377+00' },
        { updatedAtText: '2026-11-14 13:05:40.000001+00' },
        { updatedAtText: '2026-11-14 10:00:00+00' },
      ]);

      const { data } = envelope<DocumentBody>(await h.get(`${url}/${id}`));

      expect(data.items).toHaveLength(3);
      expect(data.items.every((item) => !other.itemIds.includes(item.id))).toBe(true);
      expect(data.itemsCursor).toBe('2026-11-14T13:05:40.412377Z');
      const micro = await insertDocumentWithItems(h.dataSource, { clientId }, [
        { updatedAtText: '2026-11-14 13:05:40.000001+00' },
      ]);
      expect((await open(micro.id)).itemsCursor).toBe('2026-11-14T13:05:40.000001Z');
    });

    it('outro usuário abre duas vezes: respostas iguais, e nada grava nem muda a posição na lista', async () => {
      const clientId = await newClient();
      const { id } = await insertDocumentWithItems(
        h.dataSource,
        { clientId, updatedByUserId: h.seed.user.id },
        2,
      );
      await updateDocumentRow(h.dataSource, id, { revision: 5, lastMutationId: randomUUID() });
      const before = await rowOf(h.dataSource, id);
      const itemsBefore = await h.dataSource.query(
        `SELECT id, "updatedAt" FROM flyer_pro_items WHERE "documentId" = $1 ORDER BY id`,
        [id],
      );
      const pageBefore = (await list(`clientId=${clientId}`)).data.map((entry) => entry.id);

      const first = await h.http().get(`/v1${url}/${id}`).set(asBruno());
      const second = await h.http().get(`/v1${url}/${id}`).set(asBruno());

      expect(first.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await rowOf(h.dataSource, id)).toEqual(before);
      expect(
        await h.dataSource.query(
          `SELECT id, "updatedAt" FROM flyer_pro_items WHERE "documentId" = $1 ORDER BY id`,
          [id],
        ),
      ).toEqual(itemsBefore);
      expect((await list(`clientId=${clientId}`)).data.map((entry) => entry.id)).toEqual(
        pageBefore,
      );
    });

    it('cena excluída, refeita ou com uma face apagada depois da criação: abre com a cópia guardada e o estado do dia', async () => {
      const gone = envelope<DocumentBody>(await create(sc().single1.id)).data;
      const redone = envelope<DocumentBody>(await create(sc().single2.id)).data;
      const halved = envelope<DocumentBody>(await create(sc().frontBack5.id)).data;
      await h.dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
        sc().single1.id,
      ]);
      await redoScene(fixture().seeder, sc().single2, { color: [200, 10, 10] });
      await deleteFaceTemplate(h.dataSource, sc().frontBack5, 'back');

      const [a, b, c] = await Promise.all([open(gone.id), open(redone.id), open(halved.id)]);

      expect(a.templateStatus).toEqual({
        available: false,
        usable: false,
        missingFaces: [],
        stale: false,
        staleKind: null,
      });
      expect(b.templateStatus).toMatchObject({ available: true, stale: true, staleKind: 'art' });
      expect(c.templateStatus).toMatchObject({ usable: false, missingFaces: ['back'] });
      expect([a.templateSnapshot, b.templateSnapshot, c.templateSnapshot]).toEqual([
        gone.templateSnapshot,
        redone.templateSnapshot,
        halved.templateSnapshot,
      ]);
      const reopened = await h.post(
        url,
        createPayload(
          { clientId: clientA(), sceneId: sc().single1.id },
          { creationKey: (await rowOf(h.dataSource, gone.id))['creationKey'] },
        ),
      );
      expect(reopened.status).toBe(200);
      expect(envelope<DocumentBody>(reopened).data.templateStatus.available).toBe(false);
    });
  });
});
