import { buildMockScriptF2, DirectorF2Context } from '../mc-director';
import { McScript, McSealProduct } from '../mc-types';

/**
 * Ofertas do F2 "ofertas em sequência" (tarefa 6.6) — as mesmas da fixture
 * `sample-6-offers.json` do pacote `@chroma/video-templates`: nomes reais de
 * varejo, preço anterior, unidade, badge, foto e `catalogId`.
 */
export const CAROUSEL_OFFERS: McSealProduct[] = [
  {
    id: 'of-arroz',
    catalogId: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
    name: 'Arroz Branco Tipo 1 5 kg',
    price: '24,90',
    originalPrice: '29,90',
    unit: null,
    badge: 'OFERTA',
    imageUrl: '/uploads/products/arroz.png',
  },
  {
    id: 'of-cafe',
    catalogId: '6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f',
    name: 'Café Torrado e Moído 500 g',
    price: '15,49',
    originalPrice: '18,99',
    unit: null,
    badge: '-18%',
    imageUrl: '/uploads/products/cafe.png',
  },
  {
    id: 'of-oleo',
    catalogId: null,
    name: 'Óleo de Soja 900 ml',
    price: '7,99',
    originalPrice: null,
    unit: 'un',
    badge: null,
    imageUrl: '/uploads/products/oleo.png',
  },
  {
    id: 'of-leite',
    catalogId: null,
    name: 'Leite Integral 1 L',
    price: '4,79',
    originalPrice: '5,49',
    unit: null,
    badge: 'LEVE 6 PAGUE 5',
    imageUrl: '/uploads/products/leite.png',
  },
  {
    id: 'of-picanha',
    catalogId: null,
    name: 'Picanha Bovina Resfriada',
    price: '69,90',
    originalPrice: null,
    unit: 'kg',
    badge: 'AÇOUGUE',
    imageUrl: '/uploads/products/picanha.png',
  },
  {
    id: 'of-refri',
    catalogId: null,
    name: 'Refrigerante Cola 2 L',
    price: '8,99',
    originalPrice: '10,49',
    unit: null,
    badge: null,
    imageUrl: '/uploads/products/refri.png',
  },
];

export function carouselContext(
  count: number,
  over: Partial<DirectorF2Context> = {},
): DirectorF2Context {
  return {
    offers: CAROUSEL_OFFERS.slice(0, count).map((o) => ({ ...o })),
    storeName: 'Mercadão',
    maxChunkS: 15,
    layoutPreset: 'character_left',
    captions: true,
    ...over,
  };
}

/** Ids de cena estáveis: `fx-line-0` (abertura) … `fx-line-{n+1}` (fechamento). */
export function lineIdFactory(): () => string {
  let n = 0;
  return () => `fx-line-${n++}`;
}

/** Roteiro F2 mock determinístico com `count` ofertas (abertura + uma por oferta + fechamento). */
export function fixtureCarouselScript(count = 4): McScript {
  return buildMockScriptF2(carouselContext(count), lineIdFactory());
}
