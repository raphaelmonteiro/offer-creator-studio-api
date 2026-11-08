import { textBlock } from './scene-prompt';

const KEEP = 'Keep the text already painted on the image exactly as it is, in the same place:';
const END = 'Never invent or add text, prices or logos. No other text, no logo, no watermark.';

describe('Bloco 8 com o texto a manter (4d, R65)', () => {
  it('com texto novo e texto a manter: as linhas da rodada, a linha de manter com as literais, e "No other text"', () => {
    expect(textBlock(['Frete grátis'], [], ['Promoção de Páscoa']).split('\n')).toEqual([
      'Put this exact Portuguese text, copied character by character, with the same accents, cedilla, uppercase and lowercase letters, punctuation and currency format:',
      'Line 1: “Frete grátis”',
      KEEP,
      '“Promoção de Páscoa”',
      END,
    ]);
  });

  it('uma linha a manter por linha, na ordem recebida', () => {
    const block = textBlock(['A'], [], ['B', 'C']).split('\n');
    expect(block.slice(-4)).toEqual([KEEP, '“B”', '“C”', END]);
  });

  it('sem texto novo, com texto a manter: Line n e "No other text", sem "No text"', () => {
    const block = textBlock([], [], ['Promoção de Páscoa']);
    expect(block).toContain('Line 1: “Promoção de Páscoa”');
    expect(block).not.toContain('No text, no letters');
    expect(block.split('\n').pop()).toBe(END);
  });

  it('sem nada: a regra de "sem texto"', () => {
    expect(textBlock([], [], [])).toBe('No text, no letters, no numbers, no logo, no watermark.');
  });

  it('só texto novo: nenhuma linha de manter', () => {
    expect(textBlock(['A'])).not.toContain('Keep the text');
  });

  it('a correção da refação vale para a linha mantida também', () => {
    const block = textBlock(
      ['A'],
      [{ asked: 'Promoção de Páscoa', read: 'Promoçao de Páscoa' }],
      ['Promoção de Páscoa'],
    );
    expect(block.startsWith('A previous attempt rendered the text as “Promoçao de Páscoa”')).toBe(
      true,
    );
    expect(block).toContain(`${KEEP}\n“Promoção de Páscoa”`);
  });
});
