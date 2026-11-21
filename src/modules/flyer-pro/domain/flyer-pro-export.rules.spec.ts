import type { ExportOptions, FlyerProExportEntry } from './flyer-pro.types';
import { exportEntry, exportOptions, png72Entry } from '../testing/flyer-pro-exports.fixture';
import { exportIssues, normalizeExportEntry } from './flyer-pro-export.rules';

const REVISION = 41;

/** O registro coerente do Piccin com as opções trocadas (e o resto de `over`). */
const entryWith = (
  options: Partial<ExportOptions>,
  over: Partial<FlyerProExportEntry> = {},
): FlyerProExportEntry => exportEntry({ options: exportOptions(options), ...over });

const issuesOf = (entry: FlyerProExportEntry, revision = REVISION) => exportIssues(entry, revision);

describe('exportIssues: coerência do preset', () => {
  it('os quatro presets coerentes não têm problema', () => {
    const coherent: FlyerProExportEntry[] = [
      entryWith({ preset: 'png-450-sheet', sheets: [1] }, { format: 'png', fileName: 'a-1.png' }),
      entryWith({ preset: 'pdf-450-all', sheets: [1, 2] }),
      entryWith({ preset: 'zip-450-all', sheets: [1, 2] }, { format: 'zip', fileName: 'a.zip' }),
      png72Entry(),
    ];

    for (const entry of coherent) expect(issuesOf(entry)).toEqual([]);
  });

  it('PDF de uma folha só é coerente (a opção "todas" aceita qualquer número de folhas)', () => {
    expect(issuesOf(entryWith({ sheets: [2] }))).toEqual([]);
  });

  it('png-450-sheet com duas folhas: PRESET_MISMATCH em options.sheets', () => {
    const entry = entryWith(
      { preset: 'png-450-sheet', sheets: [1, 2] },
      { format: 'png', fileName: 'a-1.png' },
    );

    expect(issuesOf(entry)).toEqual([{ field: 'options.sheets', code: 'PRESET_MISMATCH' }]);
  });

  it('png-72-sheet com duas folhas também é recusado, e o de uma folha só passa', () => {
    expect(issuesOf(png72Entry({ options: { ...png72Entry().options, sheets: [1, 2] } }))).toEqual([
      { field: 'options.sheets', code: 'PRESET_MISMATCH' },
    ]);
  });

  it('pdf-450-all com format png e dpi 72 (nome .png): um PRESET_MISMATCH em format e outro em options.dpi', () => {
    const entry = entryWith({ dpi: 72 }, { format: 'png', fileName: 'a-todas.png' });

    expect(issuesOf(entry)).toEqual([
      { field: 'format', code: 'PRESET_MISMATCH' },
      { field: 'options.dpi', code: 'PRESET_MISMATCH' },
    ]);
  });

  it.each([
    ['png-450-sheet', 'pdf', 450, ['format']],
    ['png-450-sheet', 'png', 72, ['options.dpi']],
    ['zip-450-all', 'pdf', 450, ['format']],
    ['png-72-sheet', 'png', 450, ['options.dpi']],
    ['pdf-450-all', 'zip', 450, ['format']],
    ['pdf-450-all', 'pdf', 72, ['options.dpi']],
  ] as const)(
    '%s com format %s e dpi %s: só o campo incoerente aponta',
    (preset, format, dpi, fields) => {
      const entry = entryWith({ preset, dpi, sheets: [1] }, { format, fileName: `a.${format}` });

      expect(issuesOf(entry).map((issue) => issue.field)).toEqual(fields);
    },
  );
});

describe('exportIssues: extensão do nome do arquivo', () => {
  it('PDF com nome de PNG: FILE_NAME_EXTENSION em fileName', () => {
    const entry = exportEntry({
      fileName: 'ofertas-piccin-semana-47-todas-450dpi-20261114-1502.png',
    });

    expect(issuesOf(entry)).toEqual([{ field: 'fileName', code: 'FILE_NAME_EXTENSION' }]);
  });

  it('ZIP com o nome certo passa', () => {
    const entry = entryWith(
      { preset: 'zip-450-all' },
      { format: 'zip', fileName: 'ofertas-piccin-semana-47-folhas-450dpi-20261114-1502.zip' },
    );

    expect(issuesOf(entry)).toEqual([]);
  });

  it('só a extensão conta: um ponto no meio do nome não engana', () => {
    expect(issuesOf(exportEntry({ fileName: 'ofertas.png.pdf' }))).toEqual([]);
    expect(issuesOf(exportEntry({ fileName: 'ofertas.pdf.png' }))).toEqual([
      { field: 'fileName', code: 'FILE_NAME_EXTENSION' },
    ]);
  });
});

describe('exportIssues: revisão à frente do encarte', () => {
  it('revisão 42 num encarte na 41: REVISION_AHEAD', () => {
    expect(issuesOf(exportEntry({ documentRevision: 42 }))).toEqual([
      { field: 'documentRevision', code: 'REVISION_AHEAD' },
    ]);
  });

  it.each([41, 38, 0])('revisão %s num encarte na 41 é aceita', (documentRevision) => {
    expect(issuesOf(exportEntry({ documentRevision }))).toEqual([]);
  });

  it('problemas juntos, na ordem: PRESET_MISMATCH, FILE_NAME_EXTENSION e REVISION_AHEAD', () => {
    const entry = entryWith(
      { preset: 'png-450-sheet', sheets: [1, 2] },
      { format: 'png', fileName: 'a-1.zip', documentRevision: 42 },
    );

    expect(issuesOf(entry)).toEqual([
      { field: 'options.sheets', code: 'PRESET_MISMATCH' },
      { field: 'fileName', code: 'FILE_NAME_EXTENSION' },
      { field: 'documentRevision', code: 'REVISION_AHEAD' },
    ]);
  });
});

describe('exportIssues: o que o registro não confere', () => {
  it('folha que o encarte não tem mais, pixels fora do preset, jpegQuality num PNG, bleed, engineVersion e problemas do Pré-flight não são problema', () => {
    const entry = png72Entry({
      engineVersion: 7,
      preflight: { problems: 12, warnings: 0, infos: 0 },
      options: {
        ...png72Entry().options,
        sheets: [3],
        widthPx: 9567,
        heightPx: 7087,
        jpegQuality: 0.95,
        bleed: true,
      },
    });

    expect(issuesOf(entry)).toEqual([]);
  });
});

describe('normalizeExportEntry: null vale como ausente (D-3)', () => {
  const nulls = () =>
    exportEntry({
      fileSize: null,
      preflight: null,
      options: { ...exportOptions(), jpegQuality: null },
    });

  it('tira fileSize, preflight e options.jpegQuality nulos: o resultado é o de um corpo sem os três', () => {
    const { fileSize: _s, preflight: _p, ...bare } = exportEntry();
    const { jpegQuality: _q, ...options } = exportOptions();
    const expected = { ...bare, options };

    const entry = normalizeExportEntry(nulls());

    expect(entry).toEqual(expected);
    expect(Object.keys(entry)).not.toContain('fileSize');
    expect(Object.keys(entry)).not.toContain('preflight');
    expect(Object.keys(entry.options)).not.toContain('jpegQuality');
  });

  it('mantém os três quando vêm com valor, inclusive jpegQuality e a contagem zerada', () => {
    const entry = exportEntry({ preflight: { problems: 0, warnings: 0, infos: 0 } });

    expect(normalizeExportEntry(entry)).toEqual(entry);
  });

  it('não muda o corpo recebido', () => {
    const body = nulls();

    normalizeExportEntry(body);

    expect(body.fileSize).toBeNull();
    expect(body.options.jpegQuality).toBeNull();
  });
});
