import {
  commandsOf,
  DOCUMENT,
  IMPORT_ID,
  importEntry,
  makeImportsManager,
  makeImportsService,
  OTHER_DOCUMENT,
} from './flyer-pro-imports.service.testutil';

const { service } = makeImportsService();

describe('FlyerProImportsService.apply: o registro da importação', () => {
  it('importação nova de "Acrescentar": grava a linha com o encarte da rota e o autor do token, sem marcar nada', async () => {
    const manager = makeImportsManager();

    const columns = await service.apply(manager, DOCUMENT, 'ana', importEntry());

    expect(columns).toEqual({});
    const [insert] = commandsOf(manager);
    expect(insert.sql).toContain('INSERT INTO "flyer_pro_imports"');
    expect(insert.sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(insert.sql).not.toContain('createdAt');
    expect(insert.params).toEqual([
      IMPORT_ID,
      DOCUMENT,
      'lista-piccin.csv',
      'csv',
      '9f2c1a7b3d4e5f60',
      'csv',
      'append',
      5,
      4,
      JSON.stringify([{ row: 7, reason: 'PRICE_MISSING', raw: 'FEIJAO CARIOCA' }]),
      'ana',
    ]);
    expect(commandsOf(manager)).toHaveLength(1);
  });

  it('importação nova de "Substituir a lista": manda gravar pagesFrozen = false junto da revisão', async () => {
    const manager = makeImportsManager();

    const columns = await service.apply(manager, DOCUMENT, 'ana', importEntry({ mode: 'replace' }));

    expect(columns).toEqual({ pagesFrozen: false });
  });

  it('sem detectedFormat grava nulo, e as recusadas seguem na ordem enviada', async () => {
    const manager = makeImportsManager();
    const rejected = [
      { row: 9, reason: 'DUPLICATE' as const, raw: 'b' },
      { row: 2, reason: 'NAME_MISSING' as const, raw: 'a' },
    ];

    await service.apply(
      manager,
      DOCUMENT,
      'ana',
      importEntry({ detectedFormat: undefined, rejected }),
    );

    const { params } = commandsOf(manager)[0];
    expect(params[5]).toBeNull();
    expect(params[9]).toBe(JSON.stringify(rejected));
  });

  it('o mesmo id já gravado neste encarte: não grava de novo, não muda a gravada e não descongela, nem no "Substituir"', async () => {
    const manager = makeImportsManager({ existingOwner: DOCUMENT });

    const columns = await service.apply(manager, DOCUMENT, 'ana', importEntry({ mode: 'replace' }));

    expect(columns).toEqual({});
    expect(commandsOf(manager).map((c) => c.sql.split(' ')[0])).toEqual(['INSERT', 'SELECT']);
  });

  it('o id de uma importação de outro encarte, vivo ou excluído: 409 com o id em details, sem filtrar deletedAt', async () => {
    const manager = makeImportsManager({ existingOwner: OTHER_DOCUMENT });

    await expect(service.apply(manager, DOCUMENT, 'ana', importEntry())).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'FLYER_PRO_IMPORT_ID_CONFLICT',
        message: 'A importação pertence a outro encarte.',
        details: { importId: IMPORT_ID },
      },
    });
    const owner = commandsOf(manager)[1];
    expect(owner.sql).not.toContain('deletedAt');
    expect(owner.sql).not.toContain('flyer_pro_documents');
    expect(owner.params).toEqual([IMPORT_ID]);
  });

  it.each([
    [{ rowCount: 5, acceptedCount: 6 }, 'COUNT_MISMATCH'],
    [{ rowCount: 5, acceptedCount: 0 }, 'EMPTY'],
  ])(
    'contagens %j: 422 com o código %s, antes de qualquer comando no banco',
    async (counts, code) => {
      const manager = makeImportsManager({ existingOwner: OTHER_DOCUMENT });

      await expect(
        service.apply(manager, DOCUMENT, 'ana', importEntry(counts)),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'FLYER_PRO_IMPORT_INVALID',
          issues: [{ field: 'acceptedCount', code }],
        },
      });
      expect(commandsOf(manager)).toEqual([]);
    },
  );

  it('o 422 das contagens vem antes do 409 do id de outro encarte', async () => {
    const manager = makeImportsManager({ existingOwner: OTHER_DOCUMENT });

    await expect(
      service.apply(manager, DOCUMENT, 'ana', importEntry({ acceptedCount: 0 })),
    ).rejects.toMatchObject({ response: { code: 'FLYER_PRO_IMPORT_INVALID' } });
  });
});
