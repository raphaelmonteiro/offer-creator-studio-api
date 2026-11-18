import {
  ANA,
  DOCUMENT,
  exportEntry,
  exportOptions,
  exportRow,
  png72Entry,
} from '../testing/flyer-pro-exports.fixture';
import {
  BRUNO,
  insertOf,
  OTHER_DOCUMENT,
  rejection,
  setupRegister as setup,
} from './flyer-pro-exports.service.testutil';

describe('FlyerProExportsService.register: primeira gravação (201)', () => {
  it('grava no encarte da rota, com o autor do token, e devolve 201 com a linha e replayed falso', async () => {
    const { register, manager } = setup();

    const { view, created } = await register();

    expect(created).toBe(true);
    expect(view).toMatchObject({
      id: exportEntry().id,
      documentId: DOCUMENT,
      format: 'pdf',
      options: exportOptions(),
      documentRevision: 41,
      engineVersion: 1,
      renderDigest: 'f3a91c07d2be4410',
      fileSize: 31457280,
      preflight: { problems: 1, warnings: 3, infos: 1 },
      fileState: 'not_stored',
      hasFile: false,
      createdByUserId: ANA,
      createdByName: 'Ana',
      replayed: false,
    });
    expect(insertOf(manager).params).toEqual([
      exportEntry().id,
      DOCUMENT,
      41,
      1,
      'f3a91c07d2be4410',
      'pdf',
      JSON.stringify(exportOptions()),
      exportEntry().fileName,
      31457280,
      JSON.stringify({ problems: 1, warnings: 3, infos: 1 }),
      ANA,
    ]);
  });

  it('o INSERT não escreve filePath, fileState nem createdAt: ficam nulo, not_stored e a hora do banco', async () => {
    const { register, manager } = setup();

    await register();

    const { sql } = insertOf(manager);
    for (const column of ['filePath', 'fileState', 'createdAt']) expect(sql).not.toContain(column);
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('outro usuário registra: o autor é o do token', async () => {
    const { register } = setup();

    const { view } = await register({}, BRUNO);

    expect(view).toMatchObject({ createdByUserId: BRUNO, createdByName: 'Bruno' });
  });

  it('PNG de 72 DPI sem fileSize, preflight nem jpegQuality: fileSize e preflight nulos e options sem a chave', async () => {
    const { registerEntry, manager } = setup();

    const { view } = await registerEntry(png72Entry());

    expect(view).toMatchObject({ fileSize: null, preflight: null });
    expect(Object.keys(view.options)).not.toContain('jpegQuality');
    expect(insertOf(manager).params.slice(8, 10)).toEqual([null, null]);
  });

  it('preflight com problemas é gravado como veio (12 problemas, 1 problema, tudo zero)', async () => {
    for (const preflight of [
      { problems: 12, warnings: 0, infos: 0 },
      { problems: 1, warnings: 3, infos: 1 },
      { problems: 0, warnings: 0, infos: 0 },
    ]) {
      const { register, manager } = setup();

      const { view } = await register({ preflight });

      expect(view.preflight).toEqual(preflight);
      expect(insertOf(manager).params[9]).toBe(JSON.stringify(preflight));
    }
  });

  it('aceita o que o registro não confere: folha que o encarte não tem, pixels, jpegQuality num PNG, bleed e engineVersion', async () => {
    const { registerEntry } = setup();
    const entry = png72Entry({
      engineVersion: 7,
      options: {
        ...png72Entry().options,
        sheets: [3],
        widthPx: 9567,
        heightPx: 7087,
        jpegQuality: 0.95,
        bleed: true,
      },
    });

    const { view, created } = await registerEntry(entry);

    expect(created).toBe(true);
    expect(view.options).toMatchObject({ sheets: [3], jpegQuality: 0.95, bleed: true });
    expect(view.engineVersion).toBe(7);
  });

  it.each([41, 38, 0])('revisão %s num encarte na 41 é aceita', async (documentRevision) => {
    const { register } = setup({ revision: 41 });

    expect((await register({ documentRevision })).created).toBe(true);
  });
});

describe('FlyerProExportsService.register: nulo nos três opcionais (D-3)', () => {
  const nulls = {
    fileSize: null,
    preflight: null,
    options: { ...png72Entry().options, jpegQuality: null },
  };

  it('na primeira gravação, fileSize e preflight vão nulos e options vai sem jpegQuality, igual a um corpo sem os três', async () => {
    const withNulls = setup();
    const without = setup();

    const first = await withNulls.registerEntry({ ...png72Entry(), ...nulls });
    await without.registerEntry(png72Entry());

    expect(first.view).toMatchObject({ fileSize: null, preflight: null });
    expect(Object.keys(first.view.options)).not.toContain('jpegQuality');
    expect(insertOf(withNulls.manager).params.slice(1)).toEqual(
      insertOf(without.manager).params.slice(1),
    );
    expect(insertOf(withNulls.manager).params[6]).not.toContain('jpegQuality');
  });

  it('no reenvio do mesmo corpo com os três nulos, 200 com replayed e a mesma linha, nunca 400 nem 500', async () => {
    const entry = { ...png72Entry(), ...nulls };
    const first = setup();
    const { view: saved } = await first.registerEntry(entry);
    const { registerEntry, manager } = setup({
      existing: exportRow({ ...saved, fileSize: null }),
    });

    const { view, created } = await registerEntry(entry);

    expect(created).toBe(false);
    expect(view).toMatchObject({ id: saved.id, replayed: true, fileSize: null, preflight: null });
    expect(insertOf(manager)).toBeUndefined();
  });
});

describe('FlyerProExportsService.register: repetição pelo mesmo id (200)', () => {
  it('o mesmo corpo de novo devolve a linha gravada com replayed verdadeiro, sem gravar outra', async () => {
    const { register, manager } = setup({ existing: exportRow() });

    const { view, created } = await register();

    expect(created).toBe(false);
    expect(view).toMatchObject({ id: exportEntry().id, documentId: DOCUMENT, replayed: true });
    expect(insertOf(manager)).toBeUndefined();
  });

  it('o mesmo id com corpo diferente devolve a linha original, sem comparar', async () => {
    const { register, manager } = setup({ existing: exportRow() });

    const { view } = await register({
      fileName: 'ofertas-piccin-semana-47-todas-450dpi-20261114-1503.pdf',
      fileSize: 1,
    });

    expect(view).toMatchObject({
      fileName: exportEntry().fileName,
      fileSize: 31457280,
      replayed: true,
    });
    expect(insertOf(manager)).toBeUndefined();
  });

  it('reenvio por outro usuário: a linha tem o autor original', async () => {
    const { register } = setup({ existing: exportRow() });

    const { view } = await register({}, BRUNO);

    expect(view).toMatchObject({ createdByUserId: ANA, createdByName: 'Ana', replayed: true });
  });

  it('registro simultâneo do mesmo id no mesmo encarte: o INSERT não grava e a releitura dá 200 com replayed', async () => {
    const { register, manager } = setup({ racing: exportRow() });

    const { view, created } = await register();

    expect(created).toBe(false);
    expect(view).toMatchObject({ replayed: true, createdByName: 'Ana' });
    expect(insertOf(manager)).toBeDefined();
  });
});

describe('FlyerProExportsService.register: id de outro encarte (409)', () => {
  it('o id é de uma exportação de outro encarte: 409 com details.exportId, sem gravar', async () => {
    const { register, manager } = setup({ existing: exportRow({ documentId: OTHER_DOCUMENT }) });

    await expect(register()).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'FLYER_PRO_EXPORT_ID_CONFLICT',
        message: 'A exportação pertence a outro encarte.',
        details: { exportId: exportEntry().id },
      },
    });
    expect(insertOf(manager)).toBeUndefined();
  });

  it('registro simultâneo do mesmo id em outro encarte: o INSERT não grava e a releitura dá 409', async () => {
    const { register } = setup({ racing: exportRow({ documentId: OTHER_DOCUMENT }) });

    await expect(register()).rejects.toMatchObject(rejection(409, 'FLYER_PRO_EXPORT_ID_CONFLICT'));
  });

  it('a linha que saiu entre a inserção e a releitura (expurgo do encarte) é 404, não 500', async () => {
    const { register, manager } = setup();
    manager.query.mockResolvedValue([]);

    await expect(register()).rejects.toMatchObject(rejection(404, 'FLYER_PRO_NOT_FOUND'));
  });
});

describe('FlyerProExportsService.register: regras de negócio (422)', () => {
  it('devolve todos os problemas de uma vez, na ordem, e não grava', async () => {
    const { register, manager } = setup({ revision: 41 });

    await expect(
      register({
        format: 'png',
        options: exportOptions({ preset: 'png-450-sheet', sheets: [1, 2] }),
        fileName: 'a-1.zip',
        documentRevision: 42,
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'FLYER_PRO_EXPORT_INVALID',
        message: 'O registro da exportação está incoerente.',
        issues: [
          { field: 'options.sheets', code: 'PRESET_MISMATCH' },
          { field: 'fileName', code: 'FILE_NAME_EXTENSION' },
          { field: 'documentRevision', code: 'REVISION_AHEAD' },
        ],
      },
    });
    expect(insertOf(manager)).toBeUndefined();
  });

  it('revisão 42 num encarte na 41 é REVISION_AHEAD, e o preset incoerente aponta em format e options.dpi', async () => {
    const ahead = setup({ revision: 41 });
    await expect(ahead.register({ documentRevision: 42 })).rejects.toMatchObject({
      response: { issues: [{ field: 'documentRevision', code: 'REVISION_AHEAD' }] },
    });
    const swapped = setup();
    await expect(
      swapped.register({
        format: 'png',
        fileName: 'a.png',
        options: exportOptions({ dpi: 72 }),
      }),
    ).rejects.toMatchObject({
      response: {
        issues: [
          { field: 'format', code: 'PRESET_MISMATCH' },
          { field: 'options.dpi', code: 'PRESET_MISMATCH' },
        ],
      },
    });
  });
});
