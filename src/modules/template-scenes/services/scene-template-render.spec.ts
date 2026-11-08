import { clipToCanvas } from './scene-template-render';

const canvas = { width: 100, height: 200 };

describe('clipToCanvas', () => {
  it('caixa toda dentro: sem corte', () => {
    expect(clipToCanvas({ left: 10, top: 20, width: 30, height: 40 }, canvas)).toEqual({
      left: 10,
      top: 20,
      crop: null,
    });
  });

  it('passou da borda esquerda e de cima: corta o que está fora', () => {
    expect(clipToCanvas({ left: -10, top: -5, width: 30, height: 40 }, canvas)).toEqual({
      left: 0,
      top: 0,
      crop: { left: 10, top: 5, width: 20, height: 35 },
    });
  });

  it('passou da borda direita e de baixo', () => {
    expect(clipToCanvas({ left: 90, top: 190, width: 30, height: 40 }, canvas)).toEqual({
      left: 90,
      top: 190,
      crop: { left: 0, top: 0, width: 10, height: 10 },
    });
  });

  it('toda de fora: nada a compor', () => {
    expect(clipToCanvas({ left: 200, top: 0, width: 30, height: 40 }, canvas)).toBeNull();
    expect(clipToCanvas({ left: -50, top: 0, width: 30, height: 40 }, canvas)).toBeNull();
  });
});
