import { callContext, itemInput } from './flyer-pro-enrich.testutil';
import { RealFlyerProEnrich } from './flyer-pro-enrich.real';

function build(available = { category: true, spell: true }) {
  const phases = {
    category: {
      isAvailable: jest.fn(() => available.category),
      run: jest.fn().mockResolvedValue(['c']),
    },
    spell: { isAvailable: jest.fn(() => available.spell), run: jest.fn().mockResolvedValue(['s']) },
    image: { run: jest.fn().mockResolvedValue(['i']) },
  };
  return { phases, port: new RealFlyerProEnrich(phases as never) };
}

describe('RealFlyerProEnrich', () => {
  it('cada fase vai para o serviço dela, com os itens e o contexto do lote', async () => {
    const { port, phases } = build();
    const items = [itemInput('ABACATE')];
    const context = callContext();

    expect(await port.categorize(items, context)).toEqual(['c']);
    expect(await port.spellcheck(items, context)).toEqual(['s']);
    expect(await port.matchImages(items, context)).toEqual(['i']);

    expect(phases.category.run).toHaveBeenCalledWith(items, context);
    expect(phases.spell.run).toHaveBeenCalledWith(items, context);
    expect(phases.image.run).toHaveBeenCalledWith(items, context);
  });

  it('a disponibilidade vem do serviço de cada fase; fotos nunca são puladas', () => {
    const { port } = build({ category: false, spell: true });

    expect(port.isAvailable('categorize')).toBe(false);
    expect(port.isAvailable('spellcheck')).toBe(true);
    expect(port.isAvailable('image_match')).toBe(true);
  });
});
