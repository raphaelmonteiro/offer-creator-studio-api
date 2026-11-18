import { exportOptions, exportRow } from '../testing/flyer-pro-exports.fixture';
import { toExportView } from './flyer-pro-export.view';

describe('toExportView', () => {
  it('traz as 15 chaves da entrada, sem filePath nem replayed, com a hora em ISO 8601 UTC', () => {
    const view = toExportView(exportRow({ fileSize: 31457280 }));

    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'documentId',
        'format',
        'options',
        'documentRevision',
        'engineVersion',
        'renderDigest',
        'fileName',
        'fileSize',
        'preflight',
        'fileState',
        'hasFile',
        'createdByUserId',
        'createdByName',
        'createdAt',
      ].sort(),
    );
    expect(view).toMatchObject({
      fileSize: 31457280,
      preflight: { problems: 1, warnings: 3, infos: 1 },
      createdByName: 'Ana',
      createdAt: '2026-11-14T18:02:11.000Z',
    });
    expect(view).not.toHaveProperty('filePath');
    expect(view).not.toHaveProperty('replayed');
  });

  it('sem arquivo guardado: fileState not_stored e hasFile falso, mesmo com filePath preenchido na linha', () => {
    const view = toExportView(exportRow({ filePath: 'exports/interno/arquivo.pdf' }));

    expect(view).toMatchObject({ fileState: 'not_stored', hasFile: false });
    expect(view).not.toHaveProperty('filePath');
    expect(JSON.stringify(view)).not.toContain('interno');
  });

  it('linha marcada como stored: hasFile verdadeiro (nenhum caminho grava isso nesta fase)', () => {
    const view = toExportView(exportRow({ fileState: 'stored' }));

    expect(view).toMatchObject({ fileState: 'stored', hasFile: true });
  });

  it('fileSize e preflight nulos saem nulos, e o resto da linha nula também', () => {
    const view = toExportView(
      exportRow({
        fileSize: null,
        preflight: null,
        renderDigest: null,
        createdByUserId: null,
        createdByName: null,
      }),
    );

    expect(view).toMatchObject({
      fileSize: null,
      preflight: null,
      renderDigest: null,
      createdByUserId: null,
      createdByName: null,
    });
  });

  it('fileSize em texto, como o driver devolve o bigint, sai número', () => {
    const view = toExportView(exportRow({ fileSize: '31457280' }));

    expect(view.fileSize).toBe(31457280);
    expect(typeof view.fileSize).toBe('number');
  });

  it('options sai como foi gravado, sem inventar jpegQuality quando não veio', () => {
    const { jpegQuality: _, ...withoutQuality } = exportOptions();

    const view = toExportView(exportRow({ options: withoutQuality }));

    expect(view.options).toEqual(withoutQuality);
    expect(Object.keys(view.options)).not.toContain('jpegQuality');
  });

  it('createdAt em texto do banco também sai em ISO 8601 UTC', () => {
    const view = toExportView(exportRow({ createdAt: '2026-11-14 18:02:11+00' }));

    expect(view.createdAt).toBe('2026-11-14T18:02:11.000Z');
  });
});
