import { isSent, missingFields } from './flyer-pro-presence';

describe('isSent', () => {
  it('só undefined e null contam como não enviado; 0, falso e vazio contam como enviado', () => {
    expect(isSent(undefined)).toBe(false);
    expect(isSent(null)).toBe(false);
    expect(isSent(0)).toBe(true);
    expect(isSent(false)).toBe(true);
    expect(isSent('')).toBe(true);
    expect(isSent({})).toBe(true);
  });
});

describe('missingFields', () => {
  it('lista os campos ausentes ou nulos, na ordem pedida', () => {
    expect(missingFields({ b: 0, c: null }, ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('corpo vazio ou indefinido lista todos', () => {
    expect(missingFields({}, ['a', 'b'])).toEqual(['a', 'b']);
    expect(missingFields(undefined, ['a'])).toEqual(['a']);
  });
});
