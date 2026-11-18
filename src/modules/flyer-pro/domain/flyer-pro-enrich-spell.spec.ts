import { spellVerdictOf } from './flyer-pro-enrich-spell';

const item = { id: 'i1', name: 'FILE DE TILAPIA CONJELADO' };
const correction = (suggestion: string, extra: object = {}) => ({
  productId: 'i1',
  field: 'name',
  original: 'x',
  suggestion,
  ...extra,
});

describe('leitura da resposta da ortografia (A-6)', () => {
  it('a correção do nome vira sugestão com o valor aparado', () => {
    expect(spellVerdictOf(item, [correction('  FILÉ DE TILÁPIA CONGELADO ')])).toEqual({
      itemId: 'i1',
      action: 'suggest',
      value: 'FILÉ DE TILÁPIA CONGELADO',
    });
  });

  it('sem correção para o item é nome sem erro (clean)', () => {
    expect(spellVerdictOf(item, [])).toEqual({ itemId: 'i1', action: 'clean' });
  });

  it('correção de outro item não vale', () => {
    expect(spellVerdictOf(item, [correction('X', { productId: 'outro' })]).action).toBe('clean');
  });

  it('só vale field "name": observation e badgeText ficam de fora', () => {
    expect(spellVerdictOf(item, [correction('X', { field: 'observation' })]).action).toBe('clean');
    expect(spellVerdictOf(item, [correction('X', { field: 'badgeText' })]).action).toBe('clean');
  });

  it('vale a primeira correção do nome', () => {
    const verdict = spellVerdictOf(item, [correction('PRIMEIRA'), correction('SEGUNDA')]);
    expect(verdict).toMatchObject({ action: 'suggest', value: 'PRIMEIRA' });
  });

  it('sugestão igual ao nome é clean', () => {
    expect(spellVerdictOf(item, [correction('FILE DE TILAPIA CONJELADO')]).action).toBe('clean');
  });

  it('sugestão vazia ou só com espaços é clean', () => {
    expect(spellVerdictOf(item, [correction('')]).action).toBe('clean');
    expect(spellVerdictOf(item, [correction('    ')]).action).toBe('clean');
  });

  it('sugestão de mais de 120 caracteres é clean; de 120 ainda vale', () => {
    expect(spellVerdictOf(item, [correction('A'.repeat(121))]).action).toBe('clean');
    expect(spellVerdictOf(item, [correction('A'.repeat(120))]).action).toBe('suggest');
  });
});
