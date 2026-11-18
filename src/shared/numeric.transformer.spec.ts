import { numericTransformer } from './numeric.transformer';

describe('numericTransformer', () => {
  it('lê o numeric do Postgres (texto) como número', () => {
    expect(numericTransformer.from('0.012345')).toBe(0.012345);
    expect(numericTransformer.from('12')).toBe(12);
  });

  it('lê número como número e nulo como null', () => {
    expect(numericTransformer.from(3.5)).toBe(3.5);
    expect(numericTransformer.from(null)).toBeNull();
    expect(numericTransformer.from(undefined)).toBeNull();
  });

  it('grava o valor como está, inclusive nulo', () => {
    expect(numericTransformer.to(0.5)).toBe(0.5);
    expect(numericTransformer.to(null)).toBeNull();
    expect(numericTransformer.to(undefined)).toBeUndefined();
  });

  it('as entidades das cenas continuam importando do lugar antigo e recebem o mesmo objeto', async () => {
    const old = await import('../modules/template-scenes/entities/numeric.transformer');
    expect(old.numericTransformer).toBe(numericTransformer);
  });
});
