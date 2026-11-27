import type {
  RawStructureSuggestion,
  StructureItemRow,
  StructureRequest,
} from './structure-suggestion.types';

/**
 * O encarte "Ofertas da semana 47" da spec `flyer-pro-structure-suggestion` (só testes): os oito itens e o retrato que a
 * tela envia, na ordem Hortifruti, Carnes, Bebidas (Bebidas fixada na página 2). Os ids são fixos para os testes
 * conferirem a ida e a volta dos apelidos.
 */
export const ABACATE_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
export const BANANA_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c12';
export const TOMATE_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c13';
export const PICANHA_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c21';
export const COXA_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c22';
export const LINGUICA_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c23';
export const CERVEJA_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c31';
export const REFRI_ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c32';

const PHOTO = (name: string) => `/uploads/products/${name}.jpg`;

/** Os oito itens do exemplo, na ordem do pedido; o TOMATE é o único sem foto. */
export const EXAMPLE_ITEMS: StructureItemRow[] = [
  {
    id: ABACATE_ID,
    name: 'ABACATE',
    price: { kind: 'simple', cents: 699 },
    unit: 'kg',
    category: 'Hortifruti',
    imageUrl: PHOTO('abacate'),
  },
  {
    id: BANANA_ID,
    name: 'BANANA PRATA',
    price: { kind: 'simple', cents: 449 },
    unit: 'kg',
    category: 'Hortifruti',
    imageUrl: PHOTO('banana'),
  },
  {
    id: TOMATE_ID,
    name: 'TOMATE',
    price: { kind: 'simple', cents: 799 },
    unit: 'kg',
    category: 'Hortifruti',
    imageUrl: null,
  },
  {
    id: PICANHA_ID,
    name: 'PICANHA BOVINA',
    price: { kind: 'from_to', cents: 6990, fromCents: 8990 },
    unit: 'kg',
    category: 'Carnes',
    imageUrl: PHOTO('picanha'),
  },
  {
    id: COXA_ID,
    name: 'COXA E SOBRECOXA DE FRANGO',
    price: { kind: 'simple', cents: 1199 },
    unit: 'kg',
    category: 'Carnes',
    imageUrl: PHOTO('coxa'),
  },
  {
    id: LINGUICA_ID,
    name: 'LINGUICA TOSCANA',
    price: { kind: 'simple', cents: 1890 },
    unit: 'kg',
    category: 'Carnes',
    imageUrl: PHOTO('linguica'),
  },
  {
    id: CERVEJA_ID,
    name: 'CERVEJA LATA 350ML',
    price: { kind: 'simple', cents: 349 },
    unit: 'cada',
    category: 'Bebidas',
    imageUrl: PHOTO('cerveja'),
  },
  {
    id: REFRI_ID,
    name: 'REFRIGERANTE 2L',
    price: { kind: 'simple', cents: 899 },
    unit: 'cada',
    category: 'Bebidas',
    imageUrl: PHOTO('refri'),
  },
];

/** A saída do provedor sem nenhuma proposta: nenhuma seção, destaque ou sugerido a desfazer, e nenhuma campanha. */
export const EMPTY_RAW_SUGGESTION: RawStructureSuggestion = {
  summary: '',
  campaign: { kind: 'none', label: '' },
  sections: [],
  heroes: [],
  unsuggest: [],
};

/** O retrato de exemplo (sem `unplaced` e sem destaques); `over` troca ou acrescenta campos de primeiro nível. */
export function exampleRequest(over: Partial<StructureRequest> = {}): StructureRequest {
  return {
    stateDigest: '5b1f0c9a27d3e846',
    pageCount: 2,
    level: 2,
    pages: [
      { page: 1, capacityCells: 8, usedCells: 6, header: true, footer: false },
      { page: 2, capacityCells: 8, usedCells: 2, header: false, footer: true },
    ],
    sections: [
      { id: 'cat:Hortifruti', itemIds: [ABACATE_ID, BANANA_ID, TOMATE_ID], cells: 3, pages: [1] },
      { id: 'cat:Carnes', itemIds: [PICANHA_ID, COXA_ID, LINGUICA_ID], cells: 3, pages: [1] },
      { id: 'cat:Bebidas', itemIds: [CERVEJA_ID, REFRI_ID], cells: 2, pages: [2], pinnedPage: 2 },
    ],
    heroes: [],
    ...over,
  };
}

/** Os itens do exemplo como o banco os recebe (sem o id, que o teste de banco gera): nome, preço, unidade, categoria e foto. */
export const exampleItemSeeds = () =>
  EXAMPLE_ITEMS.map(({ name, price, unit, category, imageUrl }) => ({
    name,
    price,
    unit,
    category,
    imageUrl,
  }));

/**
 * O retrato de exemplo com os ids dos oito itens trocados pelos `itemIds` dados (na ordem de `EXAMPLE_ITEMS`), para o teste
 * de banco pedir a sugestão sobre os itens que gravou.
 */
export function exampleRequestFor(
  itemIds: readonly string[],
  over: Partial<StructureRequest> = {},
): StructureRequest {
  const swap = new Map(EXAMPLE_ITEMS.map((item, index) => [item.id, itemIds[index]]));
  const request = exampleRequest(over);
  return {
    ...request,
    sections: request.sections.map((section) => ({
      ...section,
      itemIds: section.itemIds.map((id) => swap.get(id) ?? id),
    })),
    heroes: request.heroes.map((hero) => ({
      ...hero,
      itemId: swap.get(hero.itemId) ?? hero.itemId,
    })),
  };
}
