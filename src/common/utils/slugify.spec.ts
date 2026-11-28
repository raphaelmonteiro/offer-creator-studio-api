import { slugify } from './slugify';

describe('slugify', () => {
  it('tira o acento, põe em minúsculo e troca o que não é letra nem número por um hífen', () => {
    expect(slugify('SALSINHA MAÇO')).toBe('salsinha-maco');
    expect(slugify('Pão  Francês (KG) — 1,5')).toBe('pao-frances-kg-1-5');
  });

  it('não deixa hífen no começo nem no fim', () => {
    expect(slugify('  --Abacate--  ')).toBe('abacate');
    expect(slugify('***')).toBe('');
  });

  it('corta em 60 caracteres', () => {
    expect(slugify('a'.repeat(80))).toBe('a'.repeat(60));
  });
});
