import { importEntry } from '../testing/flyer-pro-imports.fixture';
import { nestedErrorsOf } from './dto-paths.testutil';
import { SaveFlyerProDocumentDto } from './save-flyer-pro-document.dto';

const ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
const BASE = { mutationId: ID, expectedRevision: 0, schemaVersion: 1, engineVersion: 1 };

const errorsOf = (value: unknown) =>
  nestedErrorsOf(SaveFlyerProDocumentDto, { ...BASE, import: value });
const withImport = (over: Record<string, unknown>) => errorsOf({ ...importEntry(), ...over });
const withRejected = (entry: Record<string, unknown>) =>
  errorsOf({ ...importEntry(), rejected: [{ ...importEntry().rejected[0], ...entry }] });

describe('FlyerProImportDto (só a forma, 400)', () => {
  it('aceita o registro completo, sem detectedFormat, com detectedFormat nulo (PV-2) e com rejected vazio', async () => {
    expect(await errorsOf(importEntry())).toEqual([]);
    const { detectedFormat: _, ...withoutFormat } = importEntry();
    expect(await errorsOf(withoutFormat)).toEqual([]);
    expect(await withImport({ detectedFormat: null })).toEqual([]);
    expect(await withImport({ rejected: [] })).toEqual([]);
  });

  it.each([
    'id',
    'fileName',
    'fileKind',
    'fileHash',
    'mode',
    'rowCount',
    'acceptedCount',
    'rejected',
  ])('recusa o registro sem %s', async (field) => {
    const { [field]: _, ...rest } = importEntry() as unknown as Record<string, unknown>;
    expect(await errorsOf(rest)).toEqual([`import.${field}`]);
  });

  it.each([null, 'lista.csv', 7, [], [importEntry()]])(
    'recusa import=%j (não é objeto)',
    async (value) => {
      expect(await errorsOf(value)).toContain('import');
    },
  );

  it.each([
    ['fileKind', 'ods'],
    ['mode', 'merge'],
    ['fileName', 'x'.repeat(256)],
    ['fileName', ''],
    ['fileHash', 'x'.repeat(65)],
    ['fileHash', ''],
    ['detectedFormat', 'x'.repeat(17)],
    ['rowCount', -1],
    ['acceptedCount', -1],
    ['acceptedCount', 1.5],
    ['rowCount', 2147483648],
    ['acceptedCount', 2147483648],
    ['id', 'abc'],
  ])('recusa %s=%p', async (field, value) => {
    expect(await withImport({ [field]: value })).toEqual([`import.${field}`]);
  });

  it('aceita os extremos: nome de 255, hash de 64, formato de 16, contagens de 0 a 2147483647', async () => {
    expect(
      await withImport({
        fileName: 'x'.repeat(255),
        fileHash: 'x'.repeat(64),
        detectedFormat: 'x'.repeat(16),
        rowCount: 2147483647,
        acceptedCount: 0,
      }),
    ).toEqual([]);
  });

  it('campo desconhecido no registro é recusado', async () => {
    expect(await withImport({ sheetName: 'Plan1' })).toEqual(['import.sheetName']);
  });
});

describe('FlyerProImportRejectedDto (as linhas recusadas)', () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, index) => ({ row: index + 1, reason: 'DUPLICATE', raw: 'x' }));

  it('aceita 200 entradas, com raw de 200 caracteres, e 201 é recusado', async () => {
    expect(await withImport({ rejected: entries(200) })).toEqual([]);
    expect(await withRejected({ raw: 'x'.repeat(200) })).toEqual([]);
    expect(await withImport({ rejected: entries(201) })).toEqual(['import.rejected']);
  });

  it.each([
    ['reason', 'OTHER'],
    ['row', 0],
    ['row', 1.5],
    ['raw', 'x'.repeat(201)],
    ['raw', 12],
  ])('recusa a entrada com %s=%p', async (field, value) => {
    expect(await withRejected({ [field]: value })).toEqual([`import.rejected.0.${field}`]);
  });

  it.each(['NAME_MISSING', 'PRICE_MISSING', 'PRICE_INVALID', 'PRICE_ABOVE_MAX', 'DUPLICATE'])(
    'aceita o motivo %s',
    async (reason) => {
      expect(await withRejected({ reason })).toEqual([]);
    },
  );

  it('chave desconhecida numa entrada e entrada que não é objeto são recusadas', async () => {
    expect(await withRejected({ column: 'B' })).toEqual(['import.rejected.0.column']);
    expect(await withImport({ rejected: ['x'] })).toEqual(['import.rejected.0']);
  });
});
