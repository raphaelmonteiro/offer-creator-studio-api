/**
 * Fixtures da ponte arte → projeto (D9), construídas a partir dos tipos REAIS
 * do frontend: `RawFlyerConfiguration` (`flyers.configuration`, legado e
 * multipágina) e `FlyerDocumentV2` (`flyer_builder_v2_documents.document`,
 * encarte V2 e arte social). Compartilhadas pelos specs de domínio e de service.
 */
export const ART_CATALOG_A = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
export const ART_CATALOG_B = '6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f';

/** `flyers.configuration` legada (página única): produtos do editor com preços numéricos. */
export const LEGACY_FLYER_CONFIGURATION = {
  version: '1.0',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  template: 'folheto-20x27',
  orientation: 'portrait',
  gridLayout: '3x4',
  settings: { showOriginalPrice: true },
  sections: [],
  sectionLayout: { mode: 'vertical', groups: [] },
  products: [
    {
      id: 'p-arroz',
      catalogId: ART_CATALOG_A,
      name: 'Arroz Tio João 5kg',
      price: 24.9,
      originalPrice: 29.9,
      unit: 'un',
      imageUrl: '/uploads/products/arroz.png',
      badgeText: 'OFERTA',
    },
    {
      id: 'p-feijao',
      productId: ART_CATALOG_B,
      name: 'Feijão Carioca 1kg',
      price: 7.5,
      unit: 'kg',
    },
    { id: 'p-vazio', name: '   ', price: 1 },
  ],
};

/** `flyers.configuration` multipágina: cada página tem a sua `configuration.products`. */
export const MULTIPAGE_FLYER_CONFIGURATION = {
  version: '2.0',
  activePageId: 'page-1',
  pages: [
    {
      id: 'page-1',
      pageNumber: 1,
      configuration: { ...LEGACY_FLYER_CONFIGURATION },
    },
    {
      id: 'page-2',
      pageNumber: 2,
      configuration: {
        ...LEGACY_FLYER_CONFIGURATION,
        products: [
          {
            id: 'p-cafe',
            name: 'Café Pilão 500g',
            price: 15.99,
            unit: 'un',
            imageUrl: '/uploads/gallery/cafe.png',
          },
        ],
      },
    },
  ],
};

/** Documento V2 (`flyer_builder_v2_documents.document`) de arte social com 1 página. */
export const SOCIAL_V2_DOCUMENT = {
  id: 'doc-social',
  schemaVersion: 2,
  builder: 'flyer-builder-v2',
  documentKind: 'social',
  name: 'Ofertas de sábado',
  status: 'draft',
  format: { id: 'instagram-feed', widthCm: 27, heightCm: 27 },
  productCardDefaults: {},
  productLibrarySnapshot: [],
  pages: [
    {
      id: 'page-social',
      pageNumber: 1,
      metrics: {},
      elements: [
        {
          id: 'el-logo',
          type: 'image',
          x: 10,
          y: 10,
          width: 100,
          height: 60,
          zIndex: 1,
          src: '/uploads/logos/mercado.png',
          objectFit: 'contain',
        },
        {
          id: 'el-1',
          type: 'product',
          x: 20,
          y: 120,
          width: 200,
          height: 220,
          zIndex: 2,
          displayMode: 'card',
          style: {},
          productData: {
            id: 'prod-leite',
            catalogId: ART_CATALOG_A,
            name: 'Leite Integral 1L',
            price: 4.99,
            originalPrice: 6.49,
            unit: 'un',
            imageUrl: '/uploads/products/leite.png',
          },
        },
        {
          id: 'el-2',
          type: 'product',
          x: 240,
          y: 120,
          width: 200,
          height: 220,
          zIndex: 3,
          displayMode: 'card',
          style: {},
          productData: {
            id: 'prod-queijo',
            name: 'Queijo Mussarela',
            price: 39.9,
            unit: 'kg',
          },
        },
        {
          id: 'el-3',
          type: 'product',
          x: 460,
          y: 120,
          width: 200,
          height: 220,
          zIndex: 4,
          visible: false,
          displayMode: 'card',
          style: {},
          productData: { id: 'prod-oculto', name: 'Oculto', price: 1 },
        },
        { id: 'el-txt', type: 'text', x: 0, y: 0, width: 10, height: 10, zIndex: 5, content: 'x' },
      ],
    },
  ],
};

/** Documento V2 de ENCARTE com 2 páginas (a segunda com 7 ofertas para a seleção do F2). */
export const FLYER_V2_DOCUMENT = {
  id: 'doc-flyer',
  schemaVersion: 2,
  builder: 'flyer-builder-v2',
  documentKind: 'flyer',
  name: 'Encarte quinzenal',
  status: 'draft',
  format: { id: 'folheto-20x27', widthCm: 20, heightCm: 27 },
  productCardDefaults: {},
  productLibrarySnapshot: [],
  pages: [
    {
      id: 'page-1',
      pageNumber: 1,
      metrics: {},
      elements: [
        {
          id: 'el-p1',
          type: 'product',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          zIndex: 1,
          productData: { id: 'capa-1', name: 'Capa', price: 1, unit: 'un' },
        },
      ],
    },
    {
      id: 'page-2',
      pageNumber: 2,
      metrics: {},
      elements: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((letter, index) => ({
        id: `el-${letter}`,
        type: 'product',
        x: index * 100,
        y: 0,
        width: 100,
        height: 100,
        zIndex: index + 1,
        productData: {
          id: `of-${letter}`,
          catalogId: letter === 'c' ? ART_CATALOG_B : letter === 'a' ? ART_CATALOG_A : undefined,
          name: `Oferta ${letter.toUpperCase()}`,
          price: index + 1,
          unit: 'un',
          // c e d chegam sem foto na arte
          imageUrl:
            letter === 'c' || letter === 'd' ? undefined : `/uploads/products/${letter}.png`,
        },
      })),
    },
  ],
};
