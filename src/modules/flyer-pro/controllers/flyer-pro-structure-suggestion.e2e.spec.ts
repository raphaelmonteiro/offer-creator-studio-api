import { randomUUID } from 'crypto';
import { overrideEnv } from '../../../shared/testing/e2e-app';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { exampleItemSeeds, exampleRequestFor } from '../domain/structure-suggestion.testutil';
import type { StructureSuggestionView } from '../domain/structure-suggestion.types';
import {
  DOCUMENTS_URL,
  envelope,
  rowOf,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import {
  DocumentSeed,
  insertDocumentWithItems,
  updateDocumentRow,
} from '../testing/flyer-pro-documents.fixture';

/**
 * e2e do N19 (change 24-add-flyer-pro-structure-suggestion-api) sobre o harness da 05, com o provedor simulado: o fluxo base
 * (200 com os ids reais), "não grava nada" conferido no banco, o guard JWT e o pipe global, os 404 e 422 que dependem do SQL
 * real, o limitador como provider único do módulo e a consulta dos exemplos do cliente. A regra de cada campo, a ordem das
 * conferências, o saneamento e o resto dos limites estão nos unitários (L-19).
 */
describeIfE2eDb('POST /v1/flyer-pro/documents/:id/structure-suggestion (e2e)', () => {
  // O padrão da variável é `real`: o app deste spec sobe com o simulado, e a chave da OpenAI fica vazia no harness.
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = overrideEnv({ FLYER_PRO_STRUCTURE_AI_PROVIDER: 'mock' });
  });
  afterAll(() => restoreEnv());

  const { h, clientA, asBruno, newClient } = useDocumentsE2e({ scenes: false });
  const suggestUrl = (id: string) => `${DOCUMENTS_URL}/${id}/structure-suggestion`;
  const ask = (id: string, body: object) => h.post(suggestUrl(id), body);
  const dataOf = (response: { body: unknown }) => envelope<StructureSuggestionView>(response).data;

  /** O encarte "Ofertas da semana 47" com os oito itens do exemplo gravados direto no banco, e o retrato dele. */
  async function seedDocument(over: Partial<DocumentSeed> = {}) {
    const { id, itemIds } = await insertDocumentWithItems(
      h.dataSource,
      { clientId: clientA(), name: 'Ofertas da semana 47', ...over },
      exampleItemSeeds(),
    );
    return { id, itemIds, body: exampleRequestFor(itemIds) };
  }

  /** Tudo o que a sugestão não pode tocar: a linha do encarte (colunas, `updatedAt`) e a de cada item. */
  const snapshot = async (id: string) => ({
    document: await rowOf(h.dataSource, id),
    items: await h.dataSource.query(
      `SELECT * FROM flyer_pro_items WHERE "documentId" = $1 ORDER BY "position"`,
      [id],
    ),
  });

  it('Resposta com os campos novos: Carnes com a ordem de ids reais, o desfazer da LINGUICA e a campanha, pela app montada', async () => {
    const { id, itemIds, body } = await seedDocument({
      name: 'Teste #ia-sem-sugeridos #ia-desconto',
    });
    const [, , , picanha, coxa, linguica] = itemIds;
    body.sections[1].itemIds = [coxa, linguica, picanha];
    body.suggestedHeroes = [{ itemId: linguica, size: '2x1', page: 1 }];

    const response = await ask(id, body);

    expect(response.status).toBe(200);
    const view = dataOf(response);
    const carnes = view.sections.find((section) => section.id === 'cat:Carnes');
    expect(carnes).toMatchObject({
      itemIds: [picanha, coxa, linguica],
      itemsReason: expect.stringMatching(/^\[simulado\] /),
    });
    expect(view.sections.filter((section) => section !== carnes).map((s) => s.itemIds)).toEqual([
      null,
      null,
    ]);
    expect(view.unsuggest).toEqual([
      { itemId: linguica, reason: expect.stringMatching(/^\[simulado\] /) },
    ]);
    expect(view.campaign).toEqual({ kind: 'discount', label: '[simulado] desconto' });
  });

  it('o exemplo do simulado: Carnes, Hortifruti, Bebidas, com os ids reais, e um UUID solto e um item de outro encarte no pedido são ignorados', async () => {
    const { id, itemIds, body } = await seedDocument();
    const other = await seedDocument();
    body.sections[1].itemIds.push(randomUUID(), other.itemIds[0]);

    const response = await ask(id, body);

    expect(response.status).toBe(200);
    const view = dataOf(response);
    expect(view).toMatchObject({
      source: 'mock',
      model: 'mock',
      promptVersion: 2,
      stateDigest: body.stateDigest,
      noChange: false,
      discarded: [],
      basedOn: { items: 8, sections: 3, clientFlyers: 0 },
    });
    expect(view.sections.map((section) => [section.id, section.page])).toEqual([
      ['cat:Carnes', 1],
      ['cat:Hortifruti', null],
      ['cat:Bebidas', 2],
    ]);
    const [abacate, , , picanha] = itemIds;
    expect(view.heroes.map((hero) => [hero.itemId, hero.size])).toEqual([
      [picanha, '2x1'],
      [abacate, '2x1'],
    ]);
  });

  it('não grava nada: o encarte e os itens ficam idênticos depois do 200 e depois do 503 de #ia-falha', async () => {
    const ok = await seedDocument();
    const failing = await seedDocument({ name: 'Teste #ia-falha' });
    const [okBefore, failingBefore] = [await snapshot(ok.id), await snapshot(failing.id)];

    const served = await ask(ok.id, ok.body);
    const failed = await ask(failing.id, failing.body);

    expect(served.status).toBe(200);
    expect(failed.status).toBe(503);
    expect(envelope<unknown>(failed).error).toMatchObject({
      code: 'FLYER_PRO_STRUCTURE_AI_FAILED',
      details: { reason: 'PROVIDER_ERROR', suggestionId: expect.any(String) },
    });
    expect(await snapshot(ok.id)).toEqual(okBefore);
    expect(await snapshot(failing.id)).toEqual(failingBefore);
  });

  it('sem token é 401, inclusive com :id que não é UUID (o guard vem antes do pipe); outro usuário logado recebe 200', async () => {
    const { id, body } = await seedDocument();

    const anonymous = await h
      .http()
      .post(`/v1${suggestUrl(id)}`)
      .send(body);
    const badId = await h
      .http()
      .post(`/v1${suggestUrl('abc')}`)
      .send(body);
    const bruno = await h
      .http()
      .post(`/v1${suggestUrl(id)}`)
      .set(asBruno())
      .send(body);

    expect([anonymous.status, badId.status, bruno.status]).toEqual([401, 401, 200]);
    expect(envelope<unknown>(anonymous).error?.code).toBe('UNAUTHORIZED');
  });

  it('um campo a mais no corpo, ou suggestedHeroes nulo, é 400 BAD_REQUEST (pipe global com forbidNonWhitelisted)', async () => {
    const { id, body } = await seedDocument();

    const extra = await ask(id, { ...body, names: ['PICANHA'] });
    const nulled = await ask(id, { ...body, suggestedHeroes: null });

    expect([extra.status, nulled.status]).toEqual([400, 400]);
    expect(envelope<unknown>(extra).error?.code).toBe('BAD_REQUEST');
    expect(envelope<unknown>(nulled).error?.code).toBe('BAD_REQUEST');
  });

  it('encarte excluído é 404 FLYER_PRO_NOT_FOUND; pedido só com ids de fora é 422 FLYER_PRO_NO_ITEMS', async () => {
    const removed = await seedDocument();
    await updateDocumentRow(h.dataSource, removed.id, { deletedAt: new Date() });
    const live = await seedDocument();
    const foreign = exampleRequestFor(Array.from({ length: 8 }, () => randomUUID()));

    const gone = await ask(removed.id, removed.body);
    const noItems = await ask(live.id, foreign);

    expect(gone.status).toBe(404);
    expect(envelope<unknown>(gone).error?.code).toBe('FLYER_PRO_NOT_FOUND');
    expect(noItems.status).toBe(422);
    expect(envelope<unknown>(noItems).error).toMatchObject({
      code: 'FLYER_PRO_NO_ITEMS',
      details: {},
    });
  });

  it('dois pedidos ao mesmo tempo para #ia-lenta: um 200 depois de cerca de 3 s e o outro 429 IN_FLIGHT; outro encarte corre junto', async () => {
    const slow = await seedDocument({ name: 'Teste #ia-lenta' });
    const normal = await seedDocument();
    const startedAt = Date.now();

    const [a, b, free] = await Promise.all([
      ask(slow.id, slow.body),
      ask(slow.id, slow.body),
      ask(normal.id, normal.body),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 429]);
    const refused = [a, b].find((response) => response.status === 429);
    const refusal = envelope<unknown>(refused as { body: unknown }).error;
    expect(refusal).toMatchObject({
      code: 'FLYER_PRO_STRUCTURE_AI_BUSY',
      details: { reason: 'IN_FLIGHT', retryAfterSeconds: expect.any(Number) },
    });
    const { retryAfterSeconds } = refusal?.details as { retryAfterSeconds: number };
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(free.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2900);
  });

  describe('exemplos dos encartes anteriores do cliente (consulta no SQL real)', () => {
    const deliberate = {
      sections: [{ id: 'cat:Carnes' }, { id: 'cat:Hortifruti' }, { id: 'cat:Bebidas' }],
    };

    /** Um encarte anterior do cliente, com as páginas congeladas e a ordem mexida, a menos que `over` diga outra coisa. */
    const previous = (clientId: string, over: Partial<DocumentSeed> = {}) =>
      insertDocumentWithItems(
        h.dataSource,
        { clientId, pagesFrozen: true, structure: deliberate, ...over },
        1,
      );

    /** O pedido do exemplo para um encarte do cliente dado, e quantos exemplos a sugestão usou. */
    async function clientFlyersFor(clientId: string, setup: () => Promise<unknown>) {
      await setup();
      const { id, body } = await seedDocument({
        clientId,
        pagesFrozen: true,
        structure: deliberate,
      });
      return dataOf(await ask(id, body)).basedOn.clientFlyers;
    }

    it('só conta o encarte anterior do mesmo cliente, vivo, congelado e com ordem deliberada; o próprio encarte, o excluído, o de outro cliente e o não congelado ficam de fora', async () => {
      const client = await newClient();
      const otherClient = await newClient();
      const count = await clientFlyersFor(client, async () => {
        await previous(client);
        await previous(client, { pagesFrozen: false });
        await previous(otherClient);
        const removed = await previous(client);
        await updateDocumentRow(h.dataSource, removed.id, { deletedAt: new Date() });
      });

      expect(count).toBe(1);
    });

    it('com quatro deliberados, a sugestão usa três', async () => {
      const client = await newClient();
      const count = await clientFlyersFor(client, async () => {
        for (let index = 0; index < 4; index += 1) {
          const { id } = await previous(client);
          await updateDocumentRow(h.dataSource, id, { updatedAt: new Date(2026, 10, 10 + index) });
        }
      });

      expect(count).toBe(3);
    });
  });
});
