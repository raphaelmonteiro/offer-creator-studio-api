import { ProductMetadata } from './product-metadata.schema';

/** O que a leitura por visão devolve para uma foto de leite condensado, sem EAN; `overrides` troca o que o teste precisa. */
export function visionMetadata(overrides: Partial<ProductMetadata> = {}): ProductMetadata {
  return {
    title: 'Leite Condensado Moça Lata 395g',
    category: null,
    quantity: { value: 395, unit: 'g' },
    packageType: 'lata',
    pack: null,
    alternatives: [{ brand: 'Moça', subBrand: null, variant: null }],
    ean: null,
    sku: null,
    claims: [],
    promo: null,
    dominantColors: [],
    fieldConfidence: {},
    source: 'vision',
    modelVersion: 'vision-v2',
    warnings: [],
    ...overrides,
  };
}
