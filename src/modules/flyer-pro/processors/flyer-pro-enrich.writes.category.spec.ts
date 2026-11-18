import type { CategoryVerdict } from '../providers/flyer-pro-enrich.port';
import type { EnrichItemRow } from './flyer-pro-enrich.types';
import { planWrites } from './flyer-pro-enrich.writes';
import { columnsOf, itemRow, writeContext } from './flyer-pro-enrich.writes.testutil';

const item = (category: string | null, categorySource: string | null): EnrichItemRow =>
  itemRow({ category, categorySource });

const choice = (action: 'apply' | 'suggest', category: string): CategoryVerdict => ({
  itemId: 'i1',
  action,
  category,
  confidence: 0.9,
  why: 'motivo',
});
const none: CategoryVerdict = { itemId: 'i1', action: 'none' };
const unanswered: CategoryVerdict = { itemId: 'i1', action: 'unanswered' };

function write(row: EnrichItemRow, verdict: CategoryVerdict, autoApply: boolean) {
  const [planned] = planWrites(
    { phase: 'categorize', items: [row], verdicts: [verdict] },
    writeContext(autoApply),
  );
  return planned ? { count: planned.count, columns: columnsOf(planned) } : null;
}

const suggestionOf = (columns: Record<string, unknown>) =>
  (columns.categoryReview as { suggestion: { status: string; auto?: boolean } | null }).suggestion;

describe('veredito da categoria → o que o job grava (tabela do design.md)', () => {
  it('sem categoria, apply com autoApply: aplica, categorySource ai, sugestão accepted auto', () => {
    const planned = write(item(null, null), choice('apply', 'Carnes'), true);
    expect(planned?.count).toBe('applied');
    expect(planned?.columns).toMatchObject({ category: 'Carnes', categorySource: 'ai' });
    expect(suggestionOf(planned!.columns)).toMatchObject({ status: 'accepted', auto: true });
  });

  it('sem categoria, apply sem autoApply: só a sugestão pending', () => {
    const planned = write(item(null, null), choice('apply', 'Carnes'), false);
    expect(planned?.count).toBe('suggested');
    expect(planned?.columns).not.toHaveProperty('category');
    expect(suggestionOf(planned!.columns)).toMatchObject({ status: 'pending' });
  });

  it('sem categoria, suggest: sugestão pending', () => {
    expect(write(item(null, null), choice('suggest', 'Mercearia'), true)?.count).toBe('suggested');
  });

  it.each([
    ['sem categoria', item(null, null)],
    ['planilha', item('Hortifruti', 'import')],
    ['ai', item('Bebidas', 'ai')],
  ])('none (%s): categoryReview com suggestion null, sem tocar category', (_, row) => {
    const planned = write(row, none, true);
    expect(planned?.count).toBe('unchanged');
    expect(planned?.columns).not.toHaveProperty('category');
    expect(suggestionOf(planned!.columns)).toBeNull();
  });

  it('planilha, suggest com outra categoria: pending, sem trocar category nem categorySource', () => {
    const planned = write(item('Mercearia', 'import'), choice('suggest', 'Limpeza'), true);
    expect(planned?.count).toBe('suggested');
    expect(planned?.columns).not.toHaveProperty('category');
    expect(planned?.columns).not.toHaveProperty('categorySource');
  });

  it('planilha, mesma categoria (com acento): suggestion null', () => {
    const planned = write(
      item('Frios e Laticinios', 'import'),
      choice('suggest', 'Frios e Laticínios'),
      true,
    );
    expect(planned?.count).toBe('unchanged');
    expect(suggestionOf(planned!.columns)).toBeNull();
  });

  it('ai, apply na mesma categoria com autoApply: confirma, accepted auto com carimbo novo', () => {
    const planned = write(item('Bebidas', 'ai'), choice('apply', 'Bebidas'), true);
    expect(planned?.count).toBe('applied');
    expect(planned?.columns).toMatchObject({ category: 'Bebidas', categorySource: 'ai' });
    expect(suggestionOf(planned!.columns)).toMatchObject({ status: 'accepted', auto: true });
  });

  it('ai, apply na mesma categoria sem autoApply: suggestion null', () => {
    const planned = write(item('Bebidas', 'ai'), choice('apply', 'Bebidas'), false);
    expect(planned?.count).toBe('unchanged');
    expect(suggestionOf(planned!.columns)).toBeNull();
  });

  it('ai, apply em outra categoria com autoApply: troca', () => {
    const planned = write(item('Bebidas', 'ai'), choice('apply', 'Mercearia'), true);
    expect(planned?.columns).toMatchObject({ category: 'Mercearia', categorySource: 'ai' });
  });

  it('ai, apply em outra categoria sem autoApply: mantém a categoria, sugestão pending', () => {
    const planned = write(item('Bebidas', 'ai'), choice('apply', 'Mercearia'), false);
    expect(planned?.columns).not.toHaveProperty('category');
    expect(suggestionOf(planned!.columns)).toMatchObject({ status: 'pending' });
  });

  it('ai, suggest na mesma categoria: suggestion null', () => {
    const planned = write(item('Bebidas', 'ai'), choice('suggest', 'Bebidas'), true);
    expect(planned?.count).toBe('unchanged');
    expect(suggestionOf(planned!.columns)).toBeNull();
  });

  it('ai, suggest em outra categoria: mantém a categoria, sugestão pending', () => {
    const planned = write(item('Bebidas', 'ai'), choice('suggest', 'Mercearia'), true);
    expect(planned?.columns).not.toHaveProperty('category');
    expect(suggestionOf(planned!.columns)).toMatchObject({ status: 'pending' });
  });

  it('unanswered e categoria fora das 11 não gravam', () => {
    expect(write(item(null, null), unanswered, true)).toBeNull();
    expect(write(item(null, null), choice('apply', 'Açougue'), true)).toBeNull();
  });

  it('o texto "Sem categoria" nunca vai para coluna', () => {
    const planned = write(item(null, null), none, true);
    expect(JSON.stringify(planned?.columns)).not.toMatch(/sem categoria/i);
  });

  it('motivo de 6 000 caracteres: a revisão grava em até 4 KB, com a categoria inteira', () => {
    const verdict = { ...choice('suggest', 'Limpeza'), why: 'A'.repeat(6000) } as CategoryVerdict;
    const planned = write(item('Mercearia', 'import'), verdict, true);
    expect(Buffer.byteLength(JSON.stringify(planned!.columns.categoryReview))).toBeLessThanOrEqual(
      4096,
    );
    expect(
      (planned!.columns.categoryReview as { suggestion: { category: string } }).suggestion.category,
    ).toBe('Limpeza');
  });
});
