import { createEnrichPort } from './flyer-pro-enrich.factory';
import { MockFlyerProEnrich } from './flyer-pro-enrich.mock';
import { RealFlyerProEnrich } from './flyer-pro-enrich.real';

const deps = [{ first: jest.fn() }, { measure: jest.fn() }] as never[];

describe('createEnrichPort', () => {
  it('mock escolhe o simulado', () => {
    expect(createEnrichPort({ provider: 'mock' }, ...(deps as [never, never]))).toBeInstanceOf(
      MockFlyerProEnrich,
    );
  });

  it('real escolhe o real, sem exigir chave nem tocar a Galeria', () => {
    const port = createEnrichPort({ provider: 'real' }, ...(deps as [never, never]));

    expect(port).toBeInstanceOf(RealFlyerProEnrich);
    expect(port.isAvailable('image_match')).toBe(false);
  });
});
