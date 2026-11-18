import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  DocumentBody,
  envelope,
  rowOf,
  savePayload,
  SaveBody,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';

/**
 * e2e do N5 (change 09-add-flyer-pro-save-api) sobre o harness da 05, só o que depende do SQL real e do app montado: o
 * `UPDATE` direto que não mexe em revisão, autor nem hora, as páginas congeladas, o cursor que convive com o `PATCH`, e
 * os recusos do pipe global e do filtro. A regra de cada campo está nos unitários do cursor (L-19).
 */
describeIfE2eDb('PUT /v1/flyer-pro/documents/:id/cursor: etapa e estado de tela (e2e)', () => {
  const { h, url, clientA, asBruno, create, open, list, patch, put } = useDocumentsE2e({
    scenes: false,
  });
  const newDocument = async () =>
    envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
  const cursorOf = (response: { body: unknown }) =>
    envelope<{ step: string; pagesFrozen: boolean }>(response).data;
  /** As colunas que o cursor não pode mudar. */
  const untouched = async (id: string) => {
    const row = await rowOf(h.dataSource, id);
    for (const column of ['step', 'ui', 'pagesFrozen']) delete row[column];
    return row;
  };

  it('grava a etapa e o ui, devolve { step, pagesFrozen }, e a abertura devolve o mesmo ui; sem ui mantém o atual', async () => {
    const { id } = await newDocument();
    const ui = {
      assemblyZoom: 3,
      inspectorTab: 'section',
      selection: { kind: 'section', sectionId: 'cat:Carnes' },
      productsView: { query: 'frango', flags: ['noPhoto'] },
    };

    const first = await put(`${id}/cursor`, { step: 'assembly', ui });
    const kept = await put(`${id}/cursor`, { step: 'card' });

    expect(cursorOf(first)).toEqual({ step: 'assembly', pagesFrozen: true });
    expect(cursorOf(kept)).toEqual({ step: 'card', pagesFrozen: true });
    expect(await open(id)).toMatchObject({ step: 'card', ui, pagesFrozen: true });
  });

  it('não muda revision, updatedAt, updatedByUserId nem lastMutationId, e a posição na lista continua a mesma', async () => {
    const { id } = await newDocument();
    await patch(id, savePayload(0, { slices: { card: { theme: 'a' } } }));
    const other = await newDocument();
    const before = await untouched(id);
    const order = (await list(`clientId=${clientA()}`)).data.map((entry) => entry.id);

    await put(`${id}/cursor`, { step: 'structure', ui: { zoom: 1 } });
    await h.http().put(`/v1${url}/${id}/cursor`).set(asBruno()).send({ step: 'frame' });

    expect(await untouched(id)).toEqual(before);
    expect((await list(`clientId=${clientA()}`)).data.map((entry) => entry.id)).toEqual(order);
    expect(order[0]).toBe(other.id);
  });

  it('chegar à Montagem, ao Pré-flight ou ao Exportar liga pagesFrozen, e voltar a Produtos não a desliga', async () => {
    const montagem = await newDocument();
    const preflight = await newDocument();
    const exportar = await newDocument();

    expect(cursorOf(await put(`${montagem.id}/cursor`, { step: 'assembly' })).pagesFrozen).toBe(
      true,
    );
    expect(cursorOf(await put(`${preflight.id}/cursor`, { step: 'preflight' })).pagesFrozen).toBe(
      true,
    );
    expect(cursorOf(await put(`${exportar.id}/cursor`, { step: 'export' })).pagesFrozen).toBe(true);
    const back = await put(`${montagem.id}/cursor`, { step: 'products' });

    expect(cursorOf(back)).toEqual({ step: 'products', pagesFrozen: true });
    expect((await rowOf(h.dataSource, montagem.id))['pagesFrozen']).toBe(true);
  });

  it('navegar não conflita com quem edita: três cursores do Bruno e o PATCH da Ana segue aceito; o último cursor vale', async () => {
    const { id } = await newDocument();
    const ana = savePayload(0, { slices: { card: { theme: 'a' } } });

    for (const step of ['card', 'structure', 'frame']) {
      const response = await h
        .http()
        .put(`/v1${url}/${id}/cursor`)
        .set(asBruno())
        .send({ step, ui: { zoom: 2 } });
      expect(response.status).toBe(200);
    }
    const saved = await patch(id, ana);

    expect(envelope<SaveBody>(saved).data).toMatchObject({ revision: 1, applied: true });
    expect(await open(id)).toMatchObject({ step: 'frame', revision: 1 });
  });

  it('o reenvio de um PATCH continua reconhecido depois do cursor e da regravação de conferência', async () => {
    const { id } = await newDocument();
    const body = savePayload(0, { slices: { card: { theme: 'a' } } });
    await patch(id, body);

    await put(`${id}/cursor`, { step: 'card' });
    await patch(id, savePayload(1, { engineVersion: 2, layoutDigest: 'd1' }));
    const again = await patch(id, body);

    expect(envelope<SaveBody>(again).data).toMatchObject({
      replayed: true,
      applied: true,
      revision: 1,
    });
  });

  describe('o app montado: guard, pipe global, filtro e a rota', () => {
    it('sem token é 401 mesmo com id inválido; id que não é UUID e encarte excluído são o mesmo 404', async () => {
      const { id } = await newDocument();
      await h.delete(`${url}/${id}`);

      const unauthorized = await h.http().put(`/v1${url}/abc/cursor`).send({ step: 'card' });

      expect(unauthorized.status).toBe(401);
      for (const target of ['abc', id]) {
        const response = await put(`${target}/cursor`, { step: 'card' });
        expect(response.status).toBe(404);
        expect(envelope<unknown>(response).error).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
      }
    });

    it('corpo {} é 400 (nunca 500), campo desconhecido é 400 e ui de 20 KB é 422 sem gravar nada', async () => {
      const { id } = await newDocument();
      const before = await rowOf(h.dataSource, id);

      const empty = await put(`${id}/cursor`, {});
      const extra = await put(`${id}/cursor`, { step: 'card', revision: 3 });
      const big = await put(`${id}/cursor`, { step: 'assembly', ui: { a: 'x'.repeat(20 * 1024) } });

      expect([empty.status, extra.status, big.status]).toEqual([400, 400, 422]);
      expect(envelope<unknown>(empty).error).toMatchObject({ code: 'BAD_REQUEST' });
      expect(envelope<unknown>(big).error).toMatchObject({
        code: 'FLYER_PRO_UI_TOO_LARGE',
        details: { max: 16_384 },
      });
      expect(await rowOf(h.dataSource, id)).toEqual(before);
    });
  });
});
