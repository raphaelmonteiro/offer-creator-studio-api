import { compareReadText, hasTextError, normalizeReadText, wrongLines } from './scene-text-check';

describe('Conferência do texto pintado, pelo código (D-51)', () => {
  it('normaliza espaços repetidos e aspas tipográficas, e nada além', () => {
    expect(normalizeReadText('  “Oferta”   de  Páscoa ')).toBe('"Oferta" de Páscoa');
    expect(normalizeReadText('Páscoa')).not.toBe(normalizeReadText('Pascoa'));
  });

  it('compara pelo pedido devolvido ou pela posição, e linha ausente é erro', () => {
    const lines = compareReadText(
      ['Promoção de Páscoa', 'De R$ 19,90'],
      [{ pedido: 'De R$ 19,90', lido: 'De R$ 19,90' }],
    );
    expect(lines).toEqual([
      { asked: 'Promoção de Páscoa', read: '', ok: false },
      { asked: 'De R$ 19,90', read: 'De R$ 19,90', ok: true },
    ]);
    const byIndex = compareReadText(
      ['A', 'B'],
      [
        { pedido: 'a?', lido: 'A' },
        { pedido: 'b?', lido: 'B' },
      ],
    );
    expect(byIndex.every((line) => line.ok)).toBe(true);
  });

  it('cedilha, til, vírgula, ponto e R$ contam', () => {
    for (const read of ['Promocao', 'PROMOÇÃO', 'Promoção.', 'R 9,90']) {
      expect(
        hasTextError(compareReadText(['Promoção'], [{ pedido: 'Promoção', lido: read }])),
      ).toBe(true);
    }
    expect(
      hasTextError(compareReadText(['R$ 9,90'], [{ pedido: 'R$ 9,90', lido: 'R$ 9,90' }])),
    ).toBe(false);
  });

  it('sem texto esperado não há erro, e as linhas erradas saem no formato da correção', () => {
    expect(hasTextError(compareReadText([], []))).toBe(false);
    const lines = compareReadText(['Páscoa'], [{ pedido: 'Páscoa', lido: 'Pascoa' }]);
    expect(wrongLines(lines)).toEqual([{ asked: 'Páscoa', read: 'Pascoa' }]);
  });
});
