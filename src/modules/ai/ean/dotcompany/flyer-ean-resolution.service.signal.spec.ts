// O serviço puxa o importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { buildFindImagesWorld } from './flyer-ean-resolution.testutil';

/** EAN válido de exemplo (dígito verificador conferido), que não está na Galeria. */
const CERVEJA = { id: 'p-cerveja', name: 'CERVEJA PILSEN LATA 350ML', ean: '7896000000019' };

describe('FlyerEanResolutionService.findImages, o sinal do lote e a DotCompany (change 29, PV-6)', () => {
  it('a consulta paga à DotCompany não recebe o sinal do lote, nem com ele já abortado', async () => {
    const { service, lookups } = buildFindImagesWorld();
    const controller = new AbortController();
    controller.abort();

    await service.findImages([CERVEJA], null, { signal: controller.signal });

    expect(lookups.resolve).toHaveBeenCalledTimes(1);
    const args = lookups.resolve.mock.calls[0];
    expect(args).toEqual([[CERVEJA.ean], { kind: 'interactive' }]);
    expect(args.some((arg) => arg === controller.signal)).toBe(false);
  });
});
