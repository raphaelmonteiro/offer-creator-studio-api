import { canonicalJson, canonicallyEqual } from './flyer-pro-canonical';

describe('comparação canônica', () => {
  it('a ordem das chaves não conta, em qualquer profundidade', () => {
    const a = { x: { b: 1, a: [{ d: 1, c: 2 }] }, y: 0.6050000000000001 };
    const b = { y: 0.6050000000000001, x: { a: [{ c: 2, d: 1 }], b: 1 } };
    expect(canonicallyEqual(a, b)).toBe(true);
  });

  it('a ordem de uma lista conta, e valores diferentes são diferentes', () => {
    expect(canonicallyEqual([1, 2], [2, 1])).toBe(false);
    expect(canonicallyEqual({ a: 0.585 }, { a: 0.58 })).toBe(false);
  });

  it('nulo e ausente valem o mesmo; chave indefinida é ignorada', () => {
    expect(canonicallyEqual(null, undefined)).toBe(true);
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
