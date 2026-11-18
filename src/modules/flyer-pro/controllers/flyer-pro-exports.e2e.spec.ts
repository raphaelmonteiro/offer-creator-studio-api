import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { envelope, rowOf } from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocument } from '../testing/flyer-pro-documents.fixture';
import { useExportsE2e } from '../testing/flyer-pro-exports.e2e.testutil';
import {
  exportEntry,
  exportOptions,
  exportsOf,
  insertExport,
  png72Entry,
} from '../testing/flyer-pro-exports.fixture';
import type { FlyerProExportView } from '../views/flyer-pro-export.view';

type Registered = FlyerProExportView & { replayed: boolean };

/**
 * e2e do N8 e do N9 (change 38-add-flyer-pro-export-history-api) sobre o harness da 05, só o fluxo base e o que depende do app
 * montado ou do SQL real: o 201 com o autor, o 200 da repetição, o `null` dos três opcionais, a corrida no mesmo encarte
 * e em dois, as regras 422, o encarte que não muda, o 404 do encarte excluído e o guard e o pipe globais. A borda de cada
 * campo está no `*.dto.spec.ts` e as regras no spec do serviço (L-19). Do N9: a segunda página de 25 exportações, só as do
 * encarte, o autor que não existe mais, o `filePath` que não sai, a exclusão lógica que mantém as exportações e o 400 do
 * `limit=51`.
 */
describeIfE2eDb('exportações do encarte: registro (N8) e histórico (N9) (e2e)', () => {
  const { h, clientA, bruno, asBruno, register, history, noToken } = useExportsE2e();
  /** Um encarte direto no banco, na revisão 41 (o do cenário "Ofertas Piccin - semana 47"). */
  const newDocument = (over: Record<string, unknown> = {}) =>
    insertDocument(h.dataSource, { clientId: clientA(), revision: 41, ...over });
  const entry = (over: Parameters<typeof exportEntry>[0] = {}) =>
    exportEntry({ id: randomUUID(), ...over });
  const dataOf = (response: { body: unknown }) => envelope<Registered>(response).data;
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 13, minute));
  const read = async (id: string, query = '', headers?: Record<string, string>) =>
    envelope<FlyerProExportView[]>(await history(id, query, headers));

  it('N8: 201 com o autor do token, o tamanho como número e sem arquivo guardado; o Bruno registra no encarte da Ana', async () => {
    const documentId = await newDocument();
    const body = entry();

    const response = await register(documentId, body);
    const other = await register(documentId, entry(), asBruno());

    expect(response.status).toBe(201);
    expect(dataOf(response)).toMatchObject({
      id: body.id,
      documentId,
      format: 'pdf',
      options: exportOptions(),
      documentRevision: 41,
      renderDigest: 'f3a91c07d2be4410',
      fileName: body.fileName,
      fileSize: 31457280,
      preflight: { problems: 1, warnings: 3, infos: 1 },
      fileState: 'not_stored',
      hasFile: false,
      createdByUserId: h.seed.user.id,
      createdByName: h.seed.user.name,
      replayed: false,
    });
    expect(dataOf(response)).not.toHaveProperty('filePath');
    expect(new Date(dataOf(response).createdAt).toISOString()).toBe(dataOf(response).createdAt);
    expect(other.status).toBe(201);
    expect(dataOf(other)).toMatchObject({ createdByUserId: bruno().id, createdByName: 'Bruno' });
    const rows = await exportsOf(h.dataSource, documentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ filePath: null, fileState: 'not_stored' });
  });

  it('N8: o mesmo id de novo é 200 com replayed e uma linha só, mesmo com corpo diferente ou vindo de outro usuário', async () => {
    const documentId = await newDocument();
    const body = entry();
    await register(documentId, body);

    const same = await register(documentId, body);
    const different = await register(
      documentId,
      { ...body, fileName: 'ofertas-piccin-semana-47-todas-450dpi-20261114-1503.pdf', fileSize: 1 },
      asBruno(),
    );

    for (const response of [same, different]) {
      expect(response.status).toBe(200);
      expect(dataOf(response)).toMatchObject({
        id: body.id,
        replayed: true,
        fileName: body.fileName,
        fileSize: 31457280,
        createdByName: h.seed.user.name,
      });
    }
    expect(await exportsOf(h.dataSource, documentId)).toHaveLength(1);
  });

  it('N8: fileSize, preflight e jpegQuality nulos valem como ausentes: 201 e a linha sem eles; o reenvio é 200', async () => {
    const documentId = await newDocument();
    const body = { ...png72Entry(), fileSize: null, preflight: null };
    body.options = { ...body.options, jpegQuality: null };

    const first = await register(documentId, body);
    const again = await register(documentId, body);

    expect(first.status).toBe(201);
    expect(dataOf(first)).toMatchObject({ fileSize: null, preflight: null });
    expect(Object.keys(dataOf(first).options)).not.toContain('jpegQuality');
    const [row] = await exportsOf(h.dataSource, documentId);
    expect(row).toMatchObject({ fileSize: null, preflight: null });
    expect(Object.keys(row.options as object)).not.toContain('jpegQuality');
    expect(again.status).toBe(200);
    expect(dataOf(again)).toMatchObject({ replayed: true, id: body.id });
    expect(await exportsOf(h.dataSource, documentId)).toHaveLength(1);
  });

  it('N8: dois registros ao mesmo tempo: no mesmo encarte um 201 e um 200; em dois encartes um 201 e um 409; uma linha só', async () => {
    const [first, second] = [await newDocument(), await newDocument()];
    const sameDocument = entry();
    const twoDocuments = entry();

    const sameResponses = await Promise.all([
      register(first, sameDocument),
      register(first, sameDocument),
    ]);
    const crossResponses = await Promise.all([
      register(first, twoDocuments),
      register(second, twoDocuments),
    ]);

    expect(sameResponses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(sameResponses.map((r) => dataOf(r).replayed).sort()).toEqual([false, true]);
    expect(crossResponses.map((r) => r.status).sort()).toEqual([201, 409]);
    const conflict = crossResponses.find((r) => r.status === 409);
    expect(envelope<unknown>(conflict).error).toMatchObject({
      code: 'FLYER_PRO_EXPORT_ID_CONFLICT',
      message: 'A exportação pertence a outro encarte.',
      details: { exportId: twoDocuments.id },
    });
    const total =
      (await exportsOf(h.dataSource, first)).length +
      (await exportsOf(h.dataSource, second)).length;
    expect(total).toBe(2);
  });

  it('N8: regras: 422 REVISION_AHEAD contra a revisão 41 e PRESET_MISMATCH juntos; revisão 38, folha 3 e problema no Pré-flight passam', async () => {
    const documentId = await newDocument();

    const ahead = await register(documentId, entry({ documentRevision: 42 }));
    const mismatch = await register(
      documentId,
      entry({
        format: 'png',
        fileName: 'a-1.png',
        options: exportOptions({ preset: 'png-450-sheet', sheets: [1, 2] }),
      }),
    );
    const late = await register(
      documentId,
      png72Entry({
        documentRevision: 38,
        options: { ...png72Entry().options, sheets: [3] },
        preflight: { problems: 1, warnings: 0, infos: 0 },
      }),
    );

    expect(ahead.status).toBe(422);
    expect(envelope<unknown>(ahead).error).toMatchObject({
      code: 'FLYER_PRO_EXPORT_INVALID',
      message: 'O registro da exportação está incoerente.',
    });
    expect(ahead.body.error.issues).toEqual([
      { field: 'documentRevision', code: 'REVISION_AHEAD' },
    ]);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.issues).toEqual([
      { field: 'options.sheets', code: 'PRESET_MISMATCH' },
    ]);
    expect(late.status).toBe(201);
    expect(dataOf(late)).toMatchObject({ documentRevision: 38, preflight: { problems: 1 } });
    expect(await exportsOf(h.dataSource, documentId)).toHaveLength(1);
  });

  it('N8: registrar, repetir e ser recusado (422) não mudam o encarte: revision, updatedAt, autor e lastMutationId iguais', async () => {
    const documentId = await newDocument({
      updatedByUserId: h.seed.user.id,
      lastMutationId: randomUUID(),
    });
    const before = await rowOf(h.dataSource, documentId);
    const body = entry();

    await register(documentId, body, asBruno());
    await register(documentId, body, asBruno());
    await register(documentId, entry({ documentRevision: 42 }), asBruno());

    expect(await rowOf(h.dataSource, documentId)).toEqual(before);
  });

  it('N8: encarte excluído pelo N6 é 404 no registro novo e na repetição, e as exportações continuam no banco; o id dele noutro encarte vivo é 409; id que não é UUID é o mesmo 404', async () => {
    const documentId = await newDocument();
    const body = entry();
    await register(documentId, body);
    await h.delete(`/flyer-pro/documents/${documentId}`);
    const alive = await newDocument();

    const responses = [
      await register(documentId, body),
      await register(documentId, entry()),
      await register('abc', entry()),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(envelope<unknown>(response).error).toMatchObject({
        code: 'FLYER_PRO_NOT_FOUND',
        message: 'Encarte não encontrado ou excluído.',
      });
    }
    expect(await exportsOf(h.dataSource, documentId)).toHaveLength(1);
    const taken = await register(alive, body);
    expect(taken.status).toBe(409);
    expect(envelope<unknown>(taken).error).toMatchObject({
      code: 'FLYER_PRO_EXPORT_ID_CONFLICT',
      details: { exportId: body.id },
    });
    expect(await exportsOf(h.dataSource, alive)).toHaveLength(0);
  });

  it('N8: o pipe global: fileUrl no corpo é 400 e {} é 400 com a lista; sem token é 401 antes do id', async () => {
    const documentId = await newDocument();

    const unknownField = await register(documentId, { ...entry(), fileUrl: 'https://x/y.pdf' });
    const empty = await register(documentId, {});
    const unauthorized = await noToken.register('abc', entry());

    expect(unknownField.status).toBe(400);
    expect(envelope<unknown>(unknownField).error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(empty.status).toBe(400);
    expect(envelope<unknown>(empty).error?.message).toContain('Campos obrigatórios ausentes');
    expect(unauthorized.status).toBe(401);
    expect(await exportsOf(h.dataSource, documentId)).toHaveLength(0);
  });

  it('N9: com 25 exportações, a segunda página traz as 5 mais antigas em ordem decrescente e o total real', async () => {
    const documentId = await newDocument();
    const ids: string[] = [];
    for (let minute = 0; minute < 25; minute += 1) {
      ids.push(await insertExport(h.dataSource, documentId, { createdAt: at(minute) }));
    }

    const first = await read(documentId);
    const second = await read(documentId, '?page=2&limit=20');

    expect(first.data).toHaveLength(20);
    expect(first.data[0].id).toBe(ids[24]);
    expect(second.data.map((entry) => entry.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(second.pagination).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
    expect(first.pagination).toMatchObject({ page: 1, limit: 20 });
  });

  it('N9: só as exportações do encarte entram no histórico e no total', async () => {
    const documentId = await newDocument();
    const other = await newDocument();
    const newest = await insertExport(h.dataSource, documentId, { createdAt: at(5) });
    await insertExport(h.dataSource, documentId, { createdAt: at(4) });
    await insertExport(h.dataSource, other, { createdAt: at(9) });

    const result = await read(documentId);

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe(newest);
    expect(result.pagination.total).toBe(2);
  });

  it('N9: o autor que não existe mais vem com createdByName nulo, outro usuário lê o histórico e o filePath interno não sai', async () => {
    const documentId = await newDocument();
    await insertExport(h.dataSource, documentId, {
      createdByUserId: h.seed.user.id,
      createdAt: at(1),
    });
    await insertExport(h.dataSource, documentId, {
      createdByUserId: randomUUID(),
      filePath: 'exports/interno/arquivo.pdf',
      createdAt: at(2),
    });

    const asOther = await read(documentId, '', asBruno());

    expect(asOther.data.map((entry) => entry.createdByName)).toEqual([null, h.seed.user.name]);
    for (const entry of asOther.data) {
      expect(entry).toMatchObject({ fileSize: 31457280, fileState: 'not_stored', hasFile: false });
      expect(entry).not.toHaveProperty('filePath');
      expect(entry).not.toHaveProperty('replayed');
    }
  });

  it('N9: encarte sem exportação é 200 com data vazio; excluído pelo N6 é 404 e as exportações continuam no banco; id que não é UUID é o mesmo 404', async () => {
    const documentId = await newDocument();
    const empty = await read(documentId);
    await insertExport(h.dataSource, documentId);
    await h.delete(`/flyer-pro/documents/${documentId}`);

    expect(empty.data).toEqual([]);
    expect(empty.pagination).toMatchObject({ total: 0, totalPages: 0 });
    for (const target of [documentId, 'abc', randomUUID()]) {
      const response = await history(target);
      expect(response.status).toBe(404);
      expect(envelope<unknown>(response).error).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
    }
    const [{ n }] = await h.dataSource.query(
      `SELECT count(*)::int AS n FROM flyer_pro_exports WHERE "documentId" = $1`,
      [documentId],
    );
    expect(n).toBe(1);
  });

  it('N9: sem token é 401 antes do id; limit=51 é 400 pelo pipe global', async () => {
    const documentId = await newDocument();

    const unauthorized = await noToken.history('abc');
    const tooMany = await history(documentId, '?limit=51');

    expect(unauthorized.status).toBe(401);
    expect(tooMany.status).toBe(400);
    expect(envelope<unknown>(tooMany).error).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
