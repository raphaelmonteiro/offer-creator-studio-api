import { paintedBlock, paintedLinesOf, paintedTextOf } from './scene-director-blocks';

describe('Texto pintado no contexto do Diretor', () => {
  it('as linhas vêm com zona e marca; a forma antiga, só com o texto, também vale', () => {
    const version = {
      metrics: {
        paintedText: [
          'Frete grátis',
          { text: 'Promoção de Páscoa', zone: 'footer' },
          { text: 'Oferta', zone: 'footer', unchecked: true },
          { text: 'Zona inventada', zone: 'cima' },
          { zone: 'footer' },
          7,
        ],
      },
    };
    expect(paintedLinesOf(version)).toEqual([
      { text: 'Frete grátis' },
      { text: 'Promoção de Páscoa', zone: 'footer' },
      { text: 'Oferta', zone: 'footer', unchecked: true },
      { text: 'Zona inventada' },
    ]);
    expect(paintedTextOf(version)).toEqual([
      'Frete grátis',
      'Promoção de Páscoa',
      'Oferta',
      'Zona inventada',
    ]);
  });

  it('o bloco cita as linhas e marca a que não foi conferida', () => {
    expect(
      paintedBlock([{ text: 'Promoção de Páscoa' }, { text: 'Oferta', unchecked: true }]),
    ).toBe(
      'Textos já pintados na imagem atual (cite sem inventar): “Promoção de Páscoa” / “Oferta” (não conferido)',
    );
    expect(paintedBlock([])).toBe('Textos já pintados na imagem atual: nenhum.');
  });
});
