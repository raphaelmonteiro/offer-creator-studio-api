import { createEnrichPort, EnrichServices } from './flyer-pro-enrich.factory';
import { MockFlyerProEnrich } from './flyer-pro-enrich.mock';
import { RealFlyerProEnrich } from './flyer-pro-enrich.real';

function services(over: { categorization?: boolean; spellcheck?: boolean } = {}): EnrichServices {
  return [
    { first: jest.fn() } as never,
    { measure: jest.fn() } as never,
    { isAvailable: () => over.categorization ?? true, categorizeProducts: jest.fn() },
    { isAvailable: () => over.spellcheck ?? true, spellCheck: jest.fn() },
    { findImages: jest.fn() },
    { isEnabled: () => true },
  ];
}

describe('createEnrichPort', () => {
  it('mock escolhe o simulado', () => {
    expect(createEnrichPort({ provider: 'mock' }, ...services())).toBeInstanceOf(
      MockFlyerProEnrich,
    );
  });

  it('real escolhe o provedor real, nunca o simulado, sem exigir chave nem tocar a Galeria', () => {
    const gallery = { first: jest.fn() };
    const [, ...rest] = services();
    const port = createEnrichPort({ provider: 'real' }, gallery as never, ...rest);

    expect(port).toBeInstanceOf(RealFlyerProEnrich);
    expect(port).not.toBeInstanceOf(MockFlyerProEnrich);
    expect(gallery.first).not.toHaveBeenCalled();
  });

  it('real: categorias e ortografia seguem a disponibilidade do serviço; fotos nunca são puladas', () => {
    const port = createEnrichPort(
      { provider: 'real' },
      ...services({ categorization: false, spellcheck: false }),
    );

    expect(port.isAvailable('categorize')).toBe(false);
    expect(port.isAvailable('spellcheck')).toBe(false);
    expect(port.isAvailable('image_match')).toBe(true);
  });
});
