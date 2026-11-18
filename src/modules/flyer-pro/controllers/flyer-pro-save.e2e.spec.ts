import { randomUUID } from 'crypto';
import type { FlyerProSaveView } from '../views/flyer-pro-save.view';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  envelope,
  rowOf,
  savePayload,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { redoScene } from '../testing/flyer-pro-scene-edits';

/**
 * e2e do N4 (change 09-add-flyer-pro-save-api) sobre o harness da 05, só com o fluxo base e o que depende do app montado
 * ou do SQL real: a trava de linha (corrida e reenvio simultâneos), o que a regravação de conferência não toca, a ida e
 * volta do jsonb, a cópia do template remontada na transação e o desfazer da transação inteira. As bordas de campo e a
 * ordem das conferências estão nos unitários do salvar (L-19).
 */
describeIfE2eDb('PATCH /v1/flyer-pro/documents/:id: salvar (e2e)', () => {
  const { h, fixture, asBruno, bruno, newDocument, open, patch, patchAs, url } = useDocumentsE2e({
    scenes: true,
  });
  const sc = () => fixture().scenes;
  const dataOf = (response: { body: unknown }) => envelope<FlyerProSaveView>(response).data;

  it('três gravações seguidas sobem a revisão de 1 em 1; o Bruno salva a quarta e vira o autor', async () => {
    const { id } = await newDocument();
    const revisions: number[] = [];
    for (const theme of ['a', 'b', 'c']) {
      const response = await patch(
        id,
        savePayload(revisions.length, { slices: { card: { theme } } }),
      );
      expect(response.status).toBe(200);
      revisions.push(dataOf(response).revision);
    }

    const fourth = savePayload(3, { slices: { frame: { by: 'bruno' } } });
    const response = await patchAs(asBruno(), id, fourth);

    expect(revisions).toEqual([1, 2, 3]);
    expect(dataOf(response)).toMatchObject({ revision: 4, applied: true, replayed: false });
    expect(await rowOf(h.dataSource, id)).toMatchObject({
      revision: 4,
      lastMutationId: fourth.mutationId,
      updatedByUserId: bruno().id,
      card: { theme: 'c' },
      frame: { by: 'bruno' },
    });
  });

  it('revisão velha: 409 REVISION_CONFLICT com a gravação atual, e nada muda no banco', async () => {
    const { id } = await newDocument();
    await patch(id, savePayload(0, { slices: { card: { theme: 'a' } } }));
    const before = await rowOf(h.dataSource, id);

    const response = await patchAs(
      asBruno(),
      id,
      savePayload(0, { slices: { card: { theme: 'z' } } }),
    );

    expect(response.status).toBe(409);
    expect(envelope<unknown>(response).error).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: {
        revision: 1,
        updatedAt: (before['updatedAt'] as Date).toISOString(),
        updatedByUserId: h.seed.user.id,
      },
    });
    expect(await rowOf(h.dataSource, id)).toEqual(before);
  });

  it('reenvio do mesmo corpo responde replayed sem gravar; corpo antigo depois de outra gravação é 409', async () => {
    const { id } = await newDocument();
    const first = savePayload(0, { slices: { card: { theme: 'a' } } });
    expect(dataOf(await patch(id, first))).toMatchObject({ replayed: false, revision: 1 });
    const stored = await rowOf(h.dataSource, id);

    const again = await patch(id, first);

    expect(dataOf(again)).toMatchObject({ replayed: true, applied: true, revision: 1 });
    expect(await rowOf(h.dataSource, id)).toEqual(stored);
    await patch(id, savePayload(1, { slices: { card: { theme: 'b' } } }));
    expect((await patch(id, first)).status).toBe(409);
  });

  it('dois PATCH com a mesma revisão ao mesmo tempo: um 200 e um 409 com a revisão nova', async () => {
    const { id } = await newDocument();

    const responses = await Promise.all([
      patch(id, savePayload(0, { slices: { card: { theme: 'a' } } })),
      patchAs(asBruno(), id, savePayload(0, { slices: { card: { theme: 'b' } } })),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const refused = responses.find((response) => response.status === 409);
    expect(envelope<unknown>(refused).error).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { revision: 1 },
    });
    expect((await rowOf(h.dataSource, id))['revision']).toBe(1);
  });

  it('o mesmo corpo duas vezes ao mesmo tempo: um grava e o outro é replayed, e a revisão sobe uma vez', async () => {
    const { id } = await newDocument();
    const body = savePayload(0, { slices: { card: { theme: 'a' } } });

    const responses = await Promise.all([patch(id, body), patch(id, body)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => dataOf(response).replayed).sort()).toEqual([false, true]);
    expect(responses.map((response) => dataOf(response).revision)).toEqual([1, 1]);
    expect((await rowOf(h.dataSource, id))['revision']).toBe(1);
  });

  it('regravação de conferência aplicada grava só o resultado; descartada (revisão velha) não grava nada', async () => {
    const { id } = await newDocument();
    await patch(id, savePayload(0, { slices: { card: { theme: 'a' } } }));
    const before = await rowOf(h.dataSource, id);
    const result = {
      engineVersion: 2,
      layoutDigest: 'd1',
      renderDigest: 'r1',
      layoutSnapshot: { l: 1 },
    };

    const applied = await patchAs(asBruno(), id, savePayload(1, result));
    const after = await rowOf(h.dataSource, id);

    expect(dataOf(applied)).toMatchObject({ applied: true, replayed: false, revision: 1 });
    expect(after).toMatchObject({ engineVersion: 2, layoutDigest: 'd1', layoutSnapshot: { l: 1 } });
    for (const column of [
      'revision',
      'updatedAt',
      'updatedByUserId',
      'lastMutationId',
      'schemaVersion',
    ]) {
      expect(after[column]).toEqual(before[column]);
    }

    const discarded = await patch(id, savePayload(0, { ...result, layoutDigest: 'd2' }));

    expect(dataOf(discarded)).toMatchObject({ applied: false, revision: 1 });
    expect(await rowOf(h.dataSource, id)).toEqual(after);
  });

  it('a fatia assembly com frações e chaves uuid volta da abertura igual à enviada', async () => {
    const { id } = await newDocument();
    const assembly = {
      'e41a0b52-3c6d-4e7f-8a91-b2c3d4e5f6a7': { share: 0.585, other: 0.6050000000000001 },
      sectionStyles: { 'cat:Carnes': { gap: 0.1 + 0.2 } },
    };

    await patch(id, savePayload(0, { slices: { assembly } }));

    expect((await open(id)).slices.assembly).toEqual(assembly);
  });

  it('troca de cena para o 54x40 remonta a cópia na transação, volta a 2 páginas e o reenvio devolve a mesma cópia', async () => {
    const { id } = await newDocument(sc().single1.id);
    const body = savePayload(0, { setup: { sceneId: sc().tabloid3.id } });

    const response = await patch(id, body);

    expect(dataOf(response)).toMatchObject({
      revision: 1,
      format: '54x40',
      pageCount: 2,
      templateSnapshot: { sceneId: sc().tabloid3.id, format: '54x40' },
      templateStatus: { available: true, stale: false },
    });
    expect(await rowOf(h.dataSource, id)).toMatchObject({ format: '54x40', pageCount: 2 });
    const again = dataOf(await patch(id, body));
    expect(again).toMatchObject({ replayed: true, revision: 1, format: '54x40', pageCount: 2 });
    expect(again.templateSnapshot.capturedAt).toBe(dataOf(response).templateSnapshot.capturedAt);
  });

  it('Atualizar arte depois de refazer a cena grava a cópia com o fingerprint novo', async () => {
    const created = await newDocument(sc().single2.id);
    await redoScene(fixture().seeder, sc().single2, { color: [200, 10, 10] });
    expect((await open(created.id)).templateStatus).toMatchObject({
      stale: true,
      staleKind: 'art',
    });

    const response = await patch(created.id, savePayload(0, { setup: { refreshTemplate: true } }));

    const data = dataOf(response);
    expect(data).toMatchObject({ revision: 1, templateStatus: { stale: false, staleKind: null } });
    expect(data.templateSnapshot.faces[0].fingerprint).not.toBe(
      created.templateSnapshot.faces[0].fingerprint,
    );
  });

  it('cliente inexistente com uma fatia no mesmo corpo: 404 e a transação desfaz tudo', async () => {
    const { id } = await newDocument();
    const before = await rowOf(h.dataSource, id);

    const response = await patch(
      id,
      savePayload(0, { setup: { clientId: randomUUID() }, slices: { frame: { x: 1 } } }),
    );

    expect(response.status).toBe(404);
    expect(envelope<unknown>(response).error).toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    expect(await rowOf(h.dataSource, id)).toEqual(before);
  });

  describe('o app montado: guard, pipe global, filtro e a rota', () => {
    it('sem token é 401; id que não é UUID e encarte excluído são o mesmo 404', async () => {
      const { id } = await newDocument();
      await h.delete(`${url}/${id}`);

      const unauthorized = await h.http().patch(`/v1${url}/${id}`).send(savePayload(0));

      expect(unauthorized.status).toBe(401);
      for (const target of ['abc', id]) {
        const response = await patch(target, savePayload(0, { slices: { card: {} } }));
        expect(response.status).toBe(404);
        expect(envelope<unknown>(response).error).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
      }
    });

    it('corpo {} é 400 BAD_REQUEST (nunca 500); fatia desconhecida e fatia nula são 400', async () => {
      const { id } = await newDocument();

      const empty = await patch(id, {});
      const unknown = await patch(id, savePayload(0, { slices: { foo: {} } }));
      const nullSlice = await patch(id, savePayload(0, { slices: { card: null } }));

      expect([empty.status, unknown.status, nullSlice.status]).toEqual([400, 400, 400]);
      expect(envelope<unknown>(empty).error).toMatchObject({ code: 'BAD_REQUEST' });
      expect((await rowOf(h.dataSource, id))['revision']).toBe(0);
    });
  });
});
