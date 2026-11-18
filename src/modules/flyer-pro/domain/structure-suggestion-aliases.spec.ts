import { buildAliases } from './structure-suggestion-aliases';
import {
  exampleRequest,
  PICANHA_ID,
  REFRI_ID,
  ABACATE_ID,
  EXAMPLE_ITEMS,
} from './structure-suggestion.testutil';
import type { StructureSectionInput } from './structure-suggestion.types';

const realIds = (...extra: string[]) =>
  new Set([...EXAMPLE_ITEMS.map((item) => item.id), ...extra]);

describe('buildAliases: apelidos no lugar dos ids', () => {
  it('seções s1.. e itens p01.. na ordem do pedido, sem nenhum UUID no que vai ao provedor', () => {
    const aliases = buildAliases(exampleRequest().sections, realIds());
    expect([...aliases.sectionByAlias]).toEqual([
      ['s1', 'cat:Hortifruti'],
      ['s2', 'cat:Carnes'],
      ['s3', 'cat:Bebidas'],
    ]);
    expect([...aliases.itemByAlias.keys()]).toEqual([
      'p01',
      'p02',
      'p03',
      'p04',
      'p05',
      'p06',
      'p07',
      'p08',
    ]);
    expect(aliases.itemByAlias.get('p04')).toBe(PICANHA_ID);
    expect(aliases.aliasByItem.get(PICANHA_ID)).toBe('p04');
    expect(aliases.aliasBySection.get('cat:Carnes')).toBe('s2');
    expect([...aliases.itemByAlias.keys(), ...aliases.sectionByAlias.keys()].join(' ')).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}/,
    );
  });

  it('o bloco de soltos recebe apelido e os seus itens também', () => {
    const sections: StructureSectionInput[] = [
      { id: 'cat:Hortifruti', itemIds: [ABACATE_ID], cells: 1, pages: [1] },
      { id: 'cat:Carnes', itemIds: [PICANHA_ID], cells: 1, pages: [1] },
      { id: 'loose', itemIds: [REFRI_ID], cells: 1, pages: [2] },
    ];
    const aliases = buildAliases(sections, realIds());
    expect(aliases.sectionByAlias.get('s3')).toBe('loose');
    expect(aliases.itemByAlias.get('p03')).toBe(REFRI_ID);
  });

  it('id que não é item do encarte é ignorado e não deixa buraco na numeração (PV-2)', () => {
    const stranger = '11111111-1111-4111-8111-111111111111';
    const sections: StructureSectionInput[] = [
      { id: 'cat:Hortifruti', itemIds: [ABACATE_ID, stranger], cells: 1, pages: [1] },
      { id: 'cat:Carnes', itemIds: [PICANHA_ID], cells: 1, pages: [1] },
    ];
    const aliases = buildAliases(sections, realIds());
    expect([...aliases.itemByAlias]).toEqual([
      ['p01', ABACATE_ID],
      ['p02', PICANHA_ID],
    ]);
    expect(aliases.aliasByItem.has(stranger)).toBe(false);
  });

  it('item repetido mantém o apelido da primeira aparição', () => {
    const sections: StructureSectionInput[] = [
      { id: 'cat:Carnes', itemIds: [PICANHA_ID, PICANHA_ID], cells: 1, pages: [1] },
      { id: 'cat:Hortifruti', itemIds: [ABACATE_ID, PICANHA_ID], cells: 1, pages: [1] },
    ];
    const aliases = buildAliases(sections, realIds());
    expect([...aliases.itemByAlias]).toEqual([
      ['p01', PICANHA_ID],
      ['p02', ABACATE_ID],
    ]);
  });

  it('com mais de 99 itens o apelido segue em p100, p101…', () => {
    const ids = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const aliases = buildAliases(
      [{ id: 'cat:Carnes', itemIds: ids, cells: 1, pages: [1] }],
      new Set(ids),
    );
    expect(aliases.aliasByItem.get(ids[98])).toBe('p99');
    expect(aliases.aliasByItem.get(ids[99])).toBe('p100');
    expect(aliases.aliasByItem.get(ids[100])).toBe('p101');
  });
});
