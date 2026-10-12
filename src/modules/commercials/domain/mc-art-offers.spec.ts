import {
  ART_CATALOG_A as CATALOG_A,
  ART_CATALOG_B as CATALOG_B,
  LEGACY_FLYER_CONFIGURATION,
  MULTIPAGE_FLYER_CONFIGURATION,
  SOCIAL_V2_DOCUMENT,
} from './__fixtures__/mc-art-sources.fixtures';
import {
  canonicalOffersJson,
  computeSnapshotHash,
  extractOffers,
  extractOffersFromFlyerConfiguration,
  extractOffersFromV2Document,
  formatOfferPrice,
  isV2DocumentShape,
  McArtOffersError,
  selectOffers,
  sourcePageCount,
} from './mc-art-offers';

describe('mc-art-offers — extração das ofertas da arte (D9)', () => {
  it('encarte legado (página única): nome, preço, preço anterior, unidade, imagem e catalogId', () => {
    const offers = extractOffersFromFlyerConfiguration(LEGACY_FLYER_CONFIGURATION, 0);
    expect(offers).toEqual([
      {
        id: 'p-arroz',
        catalogId: CATALOG_A,
        name: 'Arroz Tio João 5kg',
        price: '24,90',
        originalPrice: '29,90',
        unit: 'un',
        imageUrl: '/uploads/products/arroz.png',
        badge: 'OFERTA', // `badgeText` do editor (F2: selo do card; fora do hash do snapshot)
      },
      {
        id: 'p-feijao',
        catalogId: CATALOG_B, // `productId` do editor legado vale como referência ao catálogo
        name: 'Feijão Carioca 1kg',
        price: '7,50',
        originalPrice: null,
        unit: 'kg',
        imageUrl: null,
      },
    ]);
  });

  it('encarte legado só tem a página 0', () => {
    expect(() => extractOffersFromFlyerConfiguration(LEGACY_FLYER_CONFIGURATION, 1)).toThrow(
      McArtOffersError,
    );
    try {
      extractOffersFromFlyerConfiguration(LEGACY_FLYER_CONFIGURATION, 1);
    } catch (err) {
      expect((err as McArtOffersError).code).toBe('PAGE_NOT_FOUND');
      expect((err as McArtOffersError).details).toEqual({ pageIndex: 1, pageCount: 1 });
    }
  });

  it('encarte multipágina: ofertas da página pedida; página inexistente → PAGE_NOT_FOUND', () => {
    expect(extractOffersFromFlyerConfiguration(MULTIPAGE_FLYER_CONFIGURATION, 1)).toEqual([
      {
        id: 'p-cafe',
        catalogId: null,
        name: 'Café Pilão 500g',
        price: '15,99',
        originalPrice: null,
        unit: 'un',
        imageUrl: '/uploads/gallery/cafe.png',
      },
    ]);
    expect(extractOffersFromFlyerConfiguration(MULTIPAGE_FLYER_CONFIGURATION, 0)).toHaveLength(2);
    expect(() => extractOffersFromFlyerConfiguration(MULTIPAGE_FLYER_CONFIGURATION, 2)).toThrow(
      /2 página\(s\)/,
    );
  });

  it('documento V2 (arte social): só elementos `product` visíveis, via `productData`', () => {
    const offers = extractOffersFromV2Document(SOCIAL_V2_DOCUMENT, 0);
    expect(offers.map((o) => o.id)).toEqual(['prod-leite', 'prod-queijo']);
    expect(offers[0]).toEqual({
      id: 'prod-leite',
      catalogId: CATALOG_A,
      name: 'Leite Integral 1L',
      price: '4,99',
      originalPrice: '6,49',
      unit: 'un',
      imageUrl: '/uploads/products/leite.png',
    });
    expect(offers[1]).toMatchObject({ catalogId: null, imageUrl: null, originalPrice: null });
  });

  it('despacho pela forma do jsonb: V2 tem pages[].elements; o resto é configuração de encarte', () => {
    expect(isV2DocumentShape(SOCIAL_V2_DOCUMENT)).toBe(true);
    expect(isV2DocumentShape(MULTIPAGE_FLYER_CONFIGURATION)).toBe(false);
    expect(isV2DocumentShape(LEGACY_FLYER_CONFIGURATION)).toBe(false);
    expect(extractOffers(SOCIAL_V2_DOCUMENT, 0)).toHaveLength(2);
    expect(extractOffers(MULTIPAGE_FLYER_CONFIGURATION, 1)).toHaveLength(1);
    expect(sourcePageCount(SOCIAL_V2_DOCUMENT)).toBe(1);
    expect(sourcePageCount(MULTIPAGE_FLYER_CONFIGURATION)).toBe(2);
    expect(sourcePageCount(LEGACY_FLYER_CONFIGURATION)).toBe(1);
  });

  it('ids repetidos na página ganham sufixo posicional (a seleção precisa de id único)', () => {
    const offers = extractOffersFromFlyerConfiguration(
      {
        template: 'x',
        products: [
          { id: 'dup', name: 'A', price: 1 },
          { id: 'dup', name: 'B', price: 2 },
        ],
      },
      0,
    );
    expect(offers.map((o) => o.id)).toEqual(['dup', 'dup#1']);
  });

  it('formatOfferPrice: número → "9,99"; "R$ 9,99" → "9,99"; "9.99" → "9,99"; inválido → null', () => {
    expect(formatOfferPrice(9.99)).toBe('9,99');
    expect(formatOfferPrice(1)).toBe('1,00');
    expect(formatOfferPrice('R$ 9,99')).toBe('9,99');
    expect(formatOfferPrice('9.99')).toBe('9,99');
    expect(formatOfferPrice('12,90')).toBe('12,90');
    expect(formatOfferPrice('')).toBeNull();
    expect(formatOfferPrice(undefined)).toBeNull();
    expect(formatOfferPrice(NaN)).toBeNull();
  });
});

describe('mc-art-offers — hash do snapshot (D9, "arte de origem alterada")', () => {
  const offers = extractOffersFromFlyerConfiguration(LEGACY_FLYER_CONFIGURATION, 0);

  it('é estável: mesma arte + mesmo asset → mesmo hash, independente da ordem das chaves', () => {
    const a = computeSnapshotHash(offers, 'asset-1');
    const reordered = offers.map((o) => {
      const { unit, price, name, imageUrl, originalPrice, id, catalogId } = o;
      return { unit, price, name, imageUrl, originalPrice, id, catalogId };
    });
    expect(computeSnapshotHash(reordered, 'asset-1')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalOffersJson(offers)).toBe(canonicalOffersJson(reordered));
  });

  it('muda com um preço editado, com a ordem das ofertas e com outro asset de arte', () => {
    const base = computeSnapshotHash(offers, 'asset-1');
    const edited = offers.map((o, i) => (i === 0 ? { ...o, price: '22,90' } : o));
    expect(computeSnapshotHash(edited, 'asset-1')).not.toBe(base);
    expect(computeSnapshotHash([...offers].reverse(), 'asset-1')).not.toBe(base);
    expect(computeSnapshotHash(offers, 'asset-2')).not.toBe(base);
  });
});

describe('mc-art-offers — seleção por formato (spec "Escolha de ofertas")', () => {
  const page = extractOffersFromFlyerConfiguration(
    {
      template: 'x',
      products: [
        { id: 'a', catalogId: CATALOG_A, name: 'A', price: 1, imageUrl: '/uploads/a.png' },
        { id: 'b', name: 'B', price: 2, imageUrl: '/uploads/b.png' },
        { id: 'c', catalogId: CATALOG_B, name: 'C', price: 3 },
        { id: 'd', name: 'D', price: 4 },
        { id: 'e', name: 'E', price: 5, imageUrl: '/uploads/e.png' },
        { id: 'f', name: 'F', price: 6, imageUrl: '/uploads/f.png' },
        { id: 'g', name: 'G', price: 7, imageUrl: '/uploads/g.png' },
      ],
    },
    0,
  );
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof McArtOffersError ? { code: err.code, details: err.details } : err;
    }
    return null;
  };

  it('offer_carousel: 3 a 6 ofertas NA ORDEM enviada, catalogId preservado', () => {
    const selected = selectOffers('offer_carousel', page, [{ id: 'e' }, { id: 'a' }, { id: 'b' }]);
    expect(selected.map((o) => o.id)).toEqual(['e', 'a', 'b']);
    expect(selected[1].catalogId).toBe(CATALOG_A);
  });

  it('offer_carousel: 2 ou 7 → OFFER_SELECTION_INVALID (guarda de regra; o DTO já dá 400)', () => {
    expect(codeOf(() => selectOffers('offer_carousel', page, [{ id: 'a' }, { id: 'b' }]))).toEqual({
      code: 'OFFER_SELECTION_INVALID',
      details: { min: 3, max: 6, received: 2 },
    });
    const seven = page.map((o) => ({ id: o.id }));
    expect(codeOf(() => selectOffers('offer_carousel', page, seven))).toMatchObject({
      code: 'OFFER_SELECTION_INVALID',
      details: { received: 7 },
    });
  });

  it('offer_carousel: oferta sem imagem → OFFER_IMAGE_REQUIRED listando as pendentes', () => {
    expect(
      codeOf(() => selectOffers('offer_carousel', page, [{ id: 'a' }, { id: 'c' }, { id: 'd' }])),
    ).toEqual({
      code: 'OFFER_IMAGE_REQUIRED',
      details: {
        offers: [
          { id: 'c', name: 'C', catalogId: CATALOG_B },
          { id: 'd', name: 'D', catalogId: null },
        ],
      },
    });
  });

  it('offer_carousel: imagem resolvida pelo catálogo (resolveImage) ou pelo imageUrl da seleção', () => {
    const selected = selectOffers(
      'offer_carousel',
      page,
      [{ id: 'a' }, { id: 'c' }, { id: 'd', imageUrl: '/uploads/gallery/d.png' }],
      (offer) => (offer.catalogId === CATALOG_B ? '/uploads/products/c.png' : null),
    );
    expect(selected.map((o) => o.imageUrl)).toEqual([
      '/uploads/a.png',
      '/uploads/products/c.png',
      '/uploads/gallery/d.png',
    ]);
  });

  it('id fora da página → OFFER_NOT_FOUND', () => {
    expect(codeOf(() => selectOffers('talking_art', page, [{ id: 'zzz' }]))).toEqual({
      code: 'OFFER_NOT_FOUND',
      details: { offerIds: ['zzz'] },
    });
  });

  it('talking_art: até 3 citadas (sem exigir imagem); 4 → OFFER_SELECTION_INVALID', () => {
    expect(selectOffers('talking_art', page, [{ id: 'c' }, { id: 'd' }]).map((o) => o.id)).toEqual([
      'c',
      'd',
    ]);
    expect(
      codeOf(() =>
        selectOffers('talking_art', page, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
      ),
    ).toMatchObject({ code: 'OFFER_SELECTION_INVALID', details: { max: 3, received: 4 } });
  });

  it('talking_art sem seleção: todas as ofertas da página (o teto de 6 é do snapshot)', () => {
    expect(selectOffers('talking_art', page, undefined)).toHaveLength(7);
    expect(selectOffers('talking_art', page, [])).toHaveLength(7);
  });
});
