import { RealFlyerProEnrich } from './flyer-pro-enrich.real';

describe('RealFlyerProEnrich (provedor real antes da change 29)', () => {
  const port = new RealFlyerProEnrich();

  it('declara as três fases indisponíveis, para o job pulá-las sem tocar item', () => {
    expect(port.isAvailable('categorize')).toBe(false);
    expect(port.isAvailable('spellcheck')).toBe(false);
    expect(port.isAvailable('image_match')).toBe(false);
  });

  it('o modelo não é o simulado', () => {
    expect(port.modelOf('image_match')).not.toBe('mock');
  });

  it('nenhuma fase cai no simulado nem chama serviço: se chamada, rejeita', async () => {
    await expect(port.categorize()).rejects.toThrow(/categorize/);
    await expect(port.spellcheck()).rejects.toThrow(/spellcheck/);
    await expect(port.matchImages()).rejects.toThrow(/image_match/);
  });
});
