import { exportEntry, exportOptions, png72Entry } from '../testing/flyer-pro-exports.fixture';
import { CreateFlyerProExportDto } from './create-flyer-pro-export.dto';
import { nestedErrorsOf } from './dto-paths.testutil';

const errorsOf = (body: object) =>
  nestedErrorsOf(CreateFlyerProExportDto, body as Record<string, unknown>);
const withBody = (over: Record<string, unknown>) => errorsOf({ ...exportEntry(), ...over });
const withOptions = (over: Record<string, unknown>) =>
  withBody({ options: { ...exportOptions(), ...over } });
const withPreflight = (value: unknown) => withBody({ preflight: value });
const without = (field: string): Record<string, unknown> => {
  const { [field]: _, ...rest } = exportEntry() as unknown as Record<string, unknown>;
  return rest;
};

describe('CreateFlyerProExportDto (só a forma, 400)', () => {
  it('aceita o PDF do Piccin, o PNG de 72 DPI sem os opcionais e folhas fora de ordem', async () => {
    expect(await errorsOf(exportEntry())).toEqual([]);
    expect(await errorsOf(png72Entry())).toEqual([]);
    expect(await withOptions({ sheets: [2, 1] })).toEqual([]);
  });

  it.each(['png-450-sheet', 'pdf-450-all', 'zip-450-all', 'png-72-sheet'])(
    'aceita o preset %s',
    async (preset) => {
      expect(await withOptions({ preset })).toEqual([]);
    },
  );

  it('fileSize, preflight e options.jpegQuality nulos passam, como ausentes (D-3)', async () => {
    expect(await withBody({ fileSize: null, preflight: null })).toEqual([]);
    expect(await withOptions({ jpegQuality: null })).toEqual([]);
    expect(await withBody({ fileSize: undefined, preflight: undefined })).toEqual([]);
  });

  it.each([
    'id',
    'format',
    'options',
    'documentRevision',
    'engineVersion',
    'renderDigest',
    'fileName',
  ])('recusa o corpo sem %s', async (field) => {
    expect(await errorsOf(without(field))).toEqual([field]);
  });

  it.each([
    'id',
    'format',
    'options',
    'documentRevision',
    'engineVersion',
    'renderDigest',
    'fileName',
  ])('recusa %s nulo (obrigatório), nunca como ausente', async (field) => {
    expect(await withBody({ [field]: null })).toEqual([field]);
  });

  it.each(['preset', 'dpi', 'unit', 'sheets', 'color', 'widthPx', 'heightPx', 'bleed'])(
    'recusa options.%s ausente e nulo',
    async (key) => {
      const { [key]: _, ...rest } = exportOptions() as unknown as Record<string, unknown>;
      expect(await withBody({ options: rest })).toEqual([`options.${key}`]);
      expect(await withOptions({ [key]: null })).toEqual([`options.${key}`]);
    },
  );

  it.each([
    ['id', 'abc'],
    ['format', 'jpg'],
    ['documentRevision', -1],
    ['documentRevision', 2147483648],
    ['documentRevision', 1.5],
    ['engineVersion', 0],
    ['engineVersion', 2147483648],
    ['renderDigest', 'x'.repeat(65)],
    ['renderDigest', ''],
    ['fileSize', 0],
    ['fileSize', 1.5],
    ['fileSize', 9007199254740992],
    ['fileName', 'Feira de Sábado.pdf'],
    ['fileName', '-feira.pdf'],
    ['fileName', 'feira.jpg'],
    ['fileName', '.pdf'],
    ['fileName', `${'a'.repeat(197)}.pdf`],
  ])('recusa %s=%p', async (field, value) => {
    expect(await withBody({ [field]: value })).toEqual([field]);
  });

  it('aceita o nome de 5 e de 200 caracteres e o fileSize no teto do inteiro seguro', async () => {
    expect(await withBody({ fileName: 'a.pdf' })).toEqual([]);
    expect(await withBody({ fileName: `${'a'.repeat(196)}.pdf` })).toEqual([]);
    expect(await withBody({ fileSize: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });

  it.each([
    ['sheets', []],
    ['sheets', [1, 1]],
    ['sheets', [5]],
    ['sheets', [0]],
    ['sheets', [1, 2, 3, 4, 1]],
    ['sheets', [1.5]],
    ['preset', 'pdf-300-all'],
    ['dpi', 300],
    ['dpi', '450'],
    ['unit', 'page'],
    ['color', 'cmyk'],
    ['bleed', 'no'],
    ['jpegQuality', 0.4],
    ['jpegQuality', 1.1],
    ['widthPx', 0],
    ['widthPx', 16385],
    ['heightPx', 0],
    ['heightPx', 16385],
  ])('recusa options.%s=%j', async (key, value) => {
    expect(await withOptions({ [key]: value })).toEqual([`options.${key}`]);
  });

  it('aceita as folhas de 1 a 4 e os limites de jpegQuality e de pixels', async () => {
    expect(await withOptions({ sheets: [1, 2, 3, 4] })).toEqual([]);
    expect(await withOptions({ jpegQuality: 0.5, widthPx: 1, heightPx: 16384 })).toEqual([]);
    expect(await withOptions({ jpegQuality: 1 })).toEqual([]);
  });

  describe('preflight', () => {
    it('aceita qualquer contagem inteira a partir de zero, inclusive com problemas', async () => {
      expect(await withPreflight({ problems: 12, warnings: 0, infos: 0 })).toEqual([]);
      expect(await withPreflight({ problems: 0, warnings: 0, infos: 0 })).toEqual([]);
    });

    it.each([
      [{ problems: -1, warnings: 0, infos: 0 }, ['preflight.problems']],
      [{ problems: 1.5, warnings: 0, infos: 0 }, ['preflight.problems']],
      [{ problems: null, warnings: 0, infos: 0 }, ['preflight.problems']],
      [{ problems: 1 }, ['preflight.warnings', 'preflight.infos']],
      [{}, ['preflight.problems', 'preflight.warnings', 'preflight.infos']],
      ['1', ['preflight']],
      [[], ['preflight']],
    ])('recusa preflight=%j', async (value, paths) => {
      expect(await withPreflight(value)).toEqual(paths);
    });
  });

  describe('campos desconhecidos', () => {
    it.each(['fileUrl', 'pageCount', 'filePath', 'fileState', 'exportedAt', 'blocks'])(
      'recusa %s no corpo (sem arquivo, sem hora do download e sem a chave antiga de bloqueios)',
      async (field) => {
        expect(await withBody({ [field]: 'x' })).toEqual([field]);
      },
    );

    it('recusa blocks dentro de preflight e cropMarks dentro de options', async () => {
      expect(await withPreflight({ problems: 0, warnings: 0, infos: 0, blocks: 1 })).toEqual([
        'preflight.blocks',
      ]);
      expect(await withOptions({ cropMarks: true })).toEqual(['options.cropMarks']);
    });
  });
});
