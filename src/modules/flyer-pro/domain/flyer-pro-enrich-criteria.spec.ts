import { BASE_ITEM, CRITERION_CASES } from './flyer-pro-enrich-criteria.cases.testutil';
import { isEligible } from './flyer-pro-enrich-criteria';

describe('isEligible (critério de cada fase, como predicado)', () => {
  describe.each([
    ['onlyMissing ligado', 0, true],
    ['onlyMissing desligado', 1, false],
  ] as const)('%s', (_, column, onlyMissing) => {
    it.each(CRITERION_CASES.map((c) => [c.label, c] as const))('%s', (_, c) => {
      const item = { ...BASE_ITEM, ...c.item };

      expect(isEligible(c.phase, item, onlyMissing)).toBe(c.eligible[column]);
    });
  });

  it('valor ausente (undefined) vale como nulo, sem lançar', () => {
    const item = { name: 'X', imageStatus: 'none' } as never;

    expect(isEligible('categorize', item, true)).toBe(true);
    expect(isEligible('spellcheck', item, true)).toBe(true);
    expect(isEligible('image_match', item, true)).toBe(true);
  });
});
