import { HttpException } from '@nestjs/common';
import { itemRow } from './flyer-pro-documents.service.testutil';
import {
  DOCUMENT,
  makeItemsManager,
  recordsOf,
  run,
  statementsOf,
  statementsStartingWith,
} from './flyer-pro-items.service.testutil';
import { FlyerProItemsService } from './flyer-pro-items.service';
import { STAMP } from './flyer-pro-save.service.testutil';

const ABACATE = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
const CERVEJA = '91fe0c3d-2a4b-4c6d-8e0f-1a2b3c4d5e6f';
const NEW_ABACATE = {
  id: ABACATE,
  position: 0,
  name: 'ABACATE',
  price: { kind: 'simple', cents: 699 },
  unit: 'kg',
};

async function refusalOf(promise: Promise<unknown>) {
  const error = (await promise.then(
    () => null,
    (caught: unknown) => caught,
  )) as HttpException;
  expect(error).toBeInstanceOf(HttpException);
  const body = error.getResponse() as { code: string; details?: unknown; issues?: unknown };
  return { status: error.getStatus(), code: body.code, details: body.details, issues: body.issues };
}

describe('FlyerProItemsService.apply: incluir, alterar e excluir', () => {
  it('item novo: um INSERT só, com os padrões do servidor e o carimbo em createdAt e updatedAt', async () => {
    const created = itemRow({ id: ABACATE });
    const manager = makeItemsManager({ found: [[], [created]] });

    const outcome = await run(manager, { upsert: [NEW_ABACATE] });

    const [insert] = statementsStartingWith(manager, 'INSERT');
    expect(statementsStartingWith(manager, 'INSERT')).toHaveLength(1);
    expect(statementsStartingWith(manager, 'UPDATE')).toHaveLength(0);
    expect(insert.params[1]).toBe(STAMP);
    expect(insert.sql).toContain('$2::timestamptz, $2::timestamptz');
    expect(recordsOf(insert)).toEqual([
      expect.objectContaining({
        id: ABACATE,
        documentId: DOCUMENT,
        name: 'ABACATE',
        category: null,
        categorySource: null,
        isAlcoholic: false,
        imageStatus: 'none',
        imageReview: null,
        spellReview: null,
        categoryReview: null,
        ean: null,
      }),
    ]);
    expect(outcome.items).toEqual([created]);
    expect(outcome.deletedItemIds).toEqual([]);
  });

  it('item existente: um UPDATE só, que muda o nome, mantém o resto e apaga o spellReview', async () => {
    const stored = itemRow({
      id: ABACATE,
      name: 'ABACATE',
      category: 'Hortifruti',
      categorySource: 'import',
      spellReview: { checkedAt: 'x', checkedName: 'ABACATE', suggestion: null },
    });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    await run(manager, { upsert: [{ id: ABACATE, name: 'ABACATE AVOCADO' }] });

    expect(statementsStartingWith(manager, 'INSERT')).toHaveLength(0);
    const [update] = statementsStartingWith(manager, 'UPDATE');
    expect(update.params).toEqual([expect.any(String), STAMP, DOCUMENT]);
    expect(update.sql).toContain('"updatedAt" = $2::timestamptz');
    expect(recordsOf(update)).toEqual([
      expect.objectContaining({
        id: ABACATE,
        name: 'ABACATE AVOCADO',
        category: 'Hortifruti',
        categorySource: 'import',
        price: stored.price,
        spellReview: null,
      }),
    ]);
  });

  it('o nome é gravado aparado', async () => {
    const manager = makeItemsManager({ found: [[], []] });

    await run(manager, { upsert: [{ ...NEW_ABACATE, name: '  ABACATE  ' }] });

    expect(recordsOf(statementsStartingWith(manager, 'INSERT')[0])[0].name).toBe('ABACATE');
  });

  it('limpar um campo: null grava nulo no item existente', async () => {
    const stored = itemRow({ id: ABACATE, ean: '7891000100103' });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    await run(manager, { upsert: [{ id: ABACATE, ean: null }] });

    expect(recordsOf(statementsStartingWith(manager, 'UPDATE')[0])[0].ean).toBeNull();
  });

  it('novos e existentes no mesmo corpo: uma inserção e uma atualização, as duas com o mesmo carimbo', async () => {
    const stored = itemRow({ id: CERVEJA });
    const manager = makeItemsManager({ found: [[stored], []] });

    await run(manager, { upsert: [NEW_ABACATE, { id: CERVEJA, name: 'CERVEJA' }] });

    const [insert] = statementsStartingWith(manager, 'INSERT');
    const [update] = statementsStartingWith(manager, 'UPDATE');
    expect(recordsOf(insert).map((row) => row.id)).toEqual([ABACATE]);
    expect(recordsOf(update).map((row) => row.id)).toEqual([CERVEJA]);
    expect([insert.params[1], update.params[1]]).toEqual([STAMP, STAMP]);
  });

  it('excluir: devolve só os ids realmente apagados; o id estranho é ignorado pelo SQL do encarte', async () => {
    const manager = makeItemsManager({ deleted: [[CERVEJA]] });

    const outcome = await run(manager, { delete: [CERVEJA, ABACATE] });

    expect(outcome.deletedItemIds).toEqual([CERVEJA]);
    const [del] = statementsStartingWith(manager, 'DELETE');
    expect(del.sql).toContain('"documentId" = $1');
    expect(del.params).toEqual([DOCUMENT, [CERVEJA, ABACATE]]);
  });

  it('corpo só com itens vazios não escreve nada e conta os itens', async () => {
    const manager = makeItemsManager();

    const outcome = await run(manager, {});

    expect(outcome).toEqual({ items: [], deletedItemIds: [] });
    expect(statementsStartingWith(manager, 'INSERT')).toHaveLength(0);
    expect(statementsStartingWith(manager, 'DELETE')).toHaveLength(0);
  });

  it('a resposta traz os itens de upsert na ordem de upsert, como ficaram', async () => {
    const [a, b] = [itemRow({ id: ABACATE }), itemRow({ id: CERVEJA })];
    const manager = makeItemsManager({ found: [[], [a, b]] });

    const outcome = await run(manager, {
      upsert: [NEW_ABACATE, { ...NEW_ABACATE, id: CERVEJA, name: 'CERVEJA' }],
    });

    expect(outcome.items.map((item) => item.id)).toEqual([ABACATE, CERVEJA]);
  });
});

describe('FlyerProItemsService.apply: ordem do ramo', () => {
  it('excluir e recriar no mesmo corpo: o item apagado vale como novo e a entrada parcial é REQUIRED_FIELD_MISSING', async () => {
    const manager = makeItemsManager({ found: [[]], deleted: [[ABACATE]] });

    await expect(
      refusalOf(run(manager, { delete: [ABACATE], upsert: [{ id: ABACATE, name: 'ABACATE' }] })),
    ).resolves.toMatchObject({
      status: 422,
      code: 'FLYER_PRO_ITEM_INVALID',
      issues: expect.arrayContaining([
        { itemId: ABACATE, field: 'price', code: 'REQUIRED_FIELD_MISSING' },
      ]),
    });
    expect(statementsStartingWith(manager, 'DELETE')[0].sql).toContain('DELETE');
    expect(statementsStartingWith(manager, 'INSERT')).toHaveLength(0);
  });

  it('o apagar vem antes de ler os itens citados', async () => {
    const manager = makeItemsManager({ found: [[], []], deleted: [[CERVEJA]] });

    await run(manager, { delete: [CERVEJA], upsert: [NEW_ABACATE] });

    expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
      manager.find.mock.invocationCallOrder[0],
    );
  });

  it('id de item de outro encarte, vivo ou excluído: 409 com os ids, antes da validação e sem gravar', async () => {
    const foreign = itemRow({ id: CERVEJA, documentId: 'outro' });
    const manager = makeItemsManager({ found: [[foreign]] });

    await expect(
      refusalOf(
        run(manager, {
          upsert: [
            { ...NEW_ABACATE, unit: 'un' },
            { id: CERVEJA, name: 'X' },
          ],
        }),
      ),
    ).resolves.toEqual({
      status: 409,
      code: 'FLYER_PRO_ITEM_ID_CONFLICT',
      details: { itemIds: [CERVEJA] },
      issues: undefined,
    });
    expect(statementsStartingWith(manager, 'INSERT')).toHaveLength(0);
    expect(statementsStartingWith(manager, 'UPDATE')).toHaveLength(0);
  });

  it('a validação junta os problemas de todos os itens e nada é gravado', async () => {
    const manager = makeItemsManager({ found: [[]] });

    await expect(
      refusalOf(
        run(manager, {
          upsert: [
            { ...NEW_ABACATE, unit: 'un' },
            { ...NEW_ABACATE, id: CERVEJA, category: 'Açougue' },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      status: 422,
      issues: [
        { itemId: ABACATE, field: 'unit', code: 'UNIT_UNKNOWN' },
        { itemId: CERVEJA, field: 'category', code: 'CATEGORY_UNKNOWN' },
      ],
    });
    expect(statementsOf(manager).filter((s) => !s.sql.startsWith('DELETE'))).toEqual([]);
  });

  it('a validação vem antes do limite: item inválido não chega a contar', async () => {
    const manager = makeItemsManager({ found: [[]], total: 501 });

    await expect(
      refusalOf(run(manager, { upsert: [{ ...NEW_ABACATE, unit: 'un' }] })),
    ).resolves.toMatchObject({ code: 'FLYER_PRO_ITEM_INVALID' });
    expect(statementsOf(manager).some((s) => s.sql.startsWith('SELECT count'))).toBe(false);
  });
});

describe('FlyerProItemsService.apply: substituir todos', () => {
  const complete = { ...NEW_ABACATE };

  it('apaga os itens do encarte que não vieram em upsert, depois de gravar, e lista os apagados', async () => {
    const stored = itemRow({
      id: ABACATE,
      galleryImageId: '141da073-e2ab-4c8e-bb79-28e24074f743',
      imageUrl: 'http://localhost:3101/uploads/gallery/a.png',
      imageWidth: 900,
      imageHeight: 700,
      imageOrigin: 'picker',
      imageStatus: 'applied',
    });
    const manager = makeItemsManager({ found: [[stored], [stored]], deleted: [[CERVEJA]] });

    const outcome = await run(manager, { replaceAll: true, upsert: [complete] });

    expect(outcome.deletedItemIds).toEqual([CERVEJA]);
    const [except] = statementsStartingWith(manager, 'DELETE');
    expect(except.sql).toContain('NOT ("id" = ANY($2::uuid[]))');
    expect(except.params).toEqual([DOCUMENT, [ABACATE]]);
    const calls = statementsOf(manager).map((s) => s.sql.split(' ')[0]);
    expect(calls.indexOf('UPDATE')).toBeLessThan(calls.indexOf('DELETE'));
    expect(recordsOf(statementsStartingWith(manager, 'UPDATE')[0])[0]).toMatchObject({
      imageUrl: stored.imageUrl,
      imageStatus: 'applied',
    });
  });

  it('upsert vazio com replaceAll apaga todos', async () => {
    const manager = makeItemsManager({ deleted: [[ABACATE, CERVEJA]] });

    const outcome = await run(manager, { replaceAll: true, upsert: [] });

    expect(outcome.deletedItemIds).toEqual([ABACATE, CERVEJA]);
    expect(statementsStartingWith(manager, 'DELETE')[0].params[1]).toEqual([]);
  });

  it('entrada parcial com replaceAll é REQUIRED_FIELD_MISSING e nenhum item é apagado', async () => {
    const stored = itemRow({ id: ABACATE });
    const manager = makeItemsManager({ found: [[stored]] });

    await expect(
      refusalOf(run(manager, { replaceAll: true, upsert: [{ id: ABACATE, name: 'ABACATE' }] })),
    ).resolves.toMatchObject({ status: 422, code: 'FLYER_PRO_ITEM_INVALID' });
    expect(statementsStartingWith(manager, 'DELETE')).toHaveLength(0);
  });
});

describe('FlyerProItemsService.apply: limite de 500 itens', () => {
  it('acima de 500 depois de gravar: 422 com o máximo e o total', async () => {
    const manager = makeItemsManager({ found: [[], []], total: 501 });

    await expect(refusalOf(run(manager, { upsert: [NEW_ABACATE] }))).resolves.toMatchObject({
      status: 422,
      code: 'FLYER_PRO_ITEM_LIMIT',
      details: { max: 500, total: 501 },
    });
  });

  it('exatamente 500 passa', async () => {
    const manager = makeItemsManager({ found: [[], []], total: 500 });

    await expect(run(manager, { upsert: [NEW_ABACATE] })).resolves.toBeDefined();
  });

  it('a contagem vem depois de gravar e de apagar', async () => {
    const manager = makeItemsManager({ found: [[], []], total: 500, deleted: [[CERVEJA]] });

    await run(manager, { delete: [CERVEJA], upsert: [NEW_ABACATE] });

    const verbs = statementsOf(manager).map((s) => s.sql.split(' ')[0]);
    expect(verbs).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
});

describe('FlyerProItemsService.currentOf', () => {
  it('traz o estado atual dos itens citados que existem no encarte, sem escrever', async () => {
    const manager = makeItemsManager({ found: [[itemRow({ id: ABACATE })]] });

    const items = await new FlyerProItemsService().currentOf(manager, DOCUMENT, [
      { id: ABACATE },
      { id: CERVEJA },
    ]);

    expect(items.map((item) => item.id)).toEqual([ABACATE]);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('sem upsert não lê nada', async () => {
    const manager = makeItemsManager();

    await expect(new FlyerProItemsService().currentOf(manager, DOCUMENT)).resolves.toEqual([]);
    expect(manager.find).not.toHaveBeenCalled();
  });
});
