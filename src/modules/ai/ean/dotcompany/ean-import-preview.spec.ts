import { EanImportJobService } from './ean-import-job.service';
import { EanImportStore } from './ean-import.store';

describe('Simulação de importação — sem API externa nem escrita', () => {
  it('separa galeria, consulta pendente, duplicatas e inválidos', async () => {
    const store = {
      buscarImagensPorEan: jest.fn().mockResolvedValue(new Map([['7891000100103', 'photo']])),
    };
    const service = new EanImportJobService(store as never, { get: () => undefined } as never);
    const result = await service.previewArquivo(
      Buffer.from(
        'ean;descricao\n7891000100103;MOÇA\n07891000100103;MOÇA repetida\n7622300873554;OREO\n123;interno\n;sem EAN\n',
      ),
    );
    expect(result).toMatchObject({
      dryRun: true,
      totalRows: 5,
      maxCredits: 4,
      maxCostBrl: '0.04',
      counts: { already_exists: 1, needs_lookup: 1, duplicate: 1, invalid: 2, internal_use: 0 },
    });
    expect(result.items[0].galleryImageId).toBe('photo');
    expect(result.items[1].galleryImageId).toBeNull();
    expect(store.buscarImagensPorEan).toHaveBeenCalledWith(['7891000100103', '7622300873554']);
  });

  it('normaliza UPC/GTIN-14 e mantém uma única foto por EAN', async () => {
    const query = jest.fn().mockResolvedValue([
      { id: 'first', ean: '07891000100103' },
      { id: 'second', ean: '7891000100103' },
      { id: 'upc', ean: '027084120134' },
    ]);
    const store = new EanImportStore({ query } as never);
    const found = await store.buscarImagensPorEan(['7891000100103', '0027084120134']);
    expect(found.get('7891000100103')).toBe('first');
    expect(found.get('0027084120134')).toBe('upc');
    expect(query.mock.calls[0][1][0]).toEqual(
      expect.arrayContaining(['07891000100103', '027084120134']),
    );
  });

  it('arquivo vazio é recusado antes de consultar o banco', async () => {
    const store = { buscarImagensPorEan: jest.fn() };
    const service = new EanImportJobService(store as never, { get: () => undefined } as never);
    await expect(service.previewArquivo(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
    expect(store.buscarImagensPorEan).not.toHaveBeenCalled();
  });
});
