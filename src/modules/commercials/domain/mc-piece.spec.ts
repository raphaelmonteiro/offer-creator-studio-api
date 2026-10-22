import {
  applyClientToPiece,
  isReadableProductName,
  MC_PIECE_MAX_BYTES,
  MC_PIECE_MAX_PRODUCTS,
  MC_PIECE_MAX_SPOKEN,
  MC_PIECE_MAX_TEXTS,
  McPieceDocument,
  McPieceProductItem,
  pieceCanonicalHash,
  pieceChangeScope,
  pieceDocumentBytes,
  pieceSpokenOffers,
  templateFromPiece,
  validatePieceDocument,
} from './mc-piece';

function item(idx: number, over: Partial<McPieceProductItem> = {}): McPieceProductItem {
  return {
    id: `p${idx}`,
    catalogId: `cat-${idx}`,
    name: `Produto ${idx} especial`,
    grams: '500 g',
    unit: 'un',
    price: `${idx + 1},99`,
    originalPrice: null,
    imageUrl: `/uploads/gallery/p${idx}.png`,
    spoken: true,
    ...over,
  };
}

function piece(over: Partial<McPieceDocument> = {}): McPieceDocument {
  return {
    schemaVersion: 1,
    aspectRatio: '9:16',
    background: { mode: 'solid', color: '#1E50C8' },
    blocks: [
      {
        id: 'logo',
        type: 'logo',
        rect: { x: 0.06, y: 0.04, w: 0.28, h: 0.12 },
        zIndex: 2,
        imageUrl: '/uploads/logos/a.png',
      },
      {
        id: 'title',
        type: 'text',
        rect: { x: 0.4, y: 0.05, w: 0.55, h: 0.1 },
        zIndex: 2,
        text: 'Qualidade e variedade todos os dias',
        fontFamily: 'Montserrat',
        fontSize: 0.05,
        color: '#FFFFFF',
        align: 'center',
        weight: 'bold',
      },
      {
        id: 'products',
        type: 'products',
        rect: { x: 0.05, y: 0.2, w: 0.9, h: 0.55 },
        zIndex: 1,
        mode: 'grid',
        layout: 'auto',
        items: [item(1), item(2), item(3), item(4)],
      },
      {
        id: 'footer',
        type: 'footer',
        rect: { x: 0, y: 0.9, w: 1, h: 0.08 },
        zIndex: 3,
        style: 'bar',
        address: 'Av. Marechal, 639',
        phone: '(11) 99432-7127',
        validity: { from: '2026-04-14', to: '2026-04-16' },
        legal: 'ou enquanto durarem os estoques',
        backgroundColor: '#0A3D91',
        textColor: '#FFFFFF',
      },
      {
        id: 'character',
        type: 'character',
        rect: { x: 0.6, y: 0.62, w: 0.35, h: 0.26 },
        zIndex: 4,
        kitId: 'kit-1',
        mode: 'in_piece',
        panel: { shape: 'card', color: '#FFFFFF' },
      },
    ],
    fonts: [{ family: 'Montserrat', url: '/uploads/fonts/montserrat.ttf' }],
    ...over,
  };
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('mc-piece — nome legível do produto (spec "nunca nome de arquivo ou EAN")', () => {
  it('aceita nomes de produto comuns', () => {
    for (const name of [
      'Picanha bovina',
      'Arroz Tipo 1 5 kg',
      'Óleo de Soja 900 ml',
      'Cerveja lata 350 ml',
    ]) {
      expect(isReadableProductName(name)).toBe(true);
    }
  });

  it('recusa arquivo, EAN, foto automática e nome sem letras', () => {
    for (const name of [
      'WhatsApp Image 2026 10 21 at 20.28.14',
      'dotcompany 7891000457092',
      '7898613840266',
      'IMG_2031.jpg',
      'foto.png',
      '',
      '12',
      '---',
    ]) {
      expect(isReadableProductName(name)).toBe(false);
    }
  });
});

describe('mc-piece — validatePieceDocument', () => {
  it('peça completa e dentro dos limites não tem issues', () => {
    expect(
      validatePieceDocument(piece(), {
        kitIdentityMode: 'generated',
        fontFamilies: ['Montserrat'],
      }),
    ).toEqual([]);
  });

  it('schema, formato e fundo são checados', () => {
    const issues = validatePieceDocument(
      piece({
        schemaVersion: 2,
        aspectRatio: '16:9' as never,
        background: { mode: 'solid', color: 'azul' },
      }),
    );
    expect(codes(issues)).toEqual(
      expect.arrayContaining(['PIECE_SCHEMA', 'PIECE_ASPECT', 'BACKGROUND_INVALID']),
    );
    expect(
      validatePieceDocument(
        piece({ background: { mode: 'image', imageUrl: 'https://x/a.png', darken: 2 } }),
      ).filter((i) => i.code === 'BACKGROUND_INVALID'),
    ).toHaveLength(2);
    expect(
      validatePieceDocument(
        piece({ background: { mode: 'gradient', colors: ['#000000', '#FFFFFF'], angle: 45 } }),
      ),
    ).toEqual([]);
  });

  it('bloco fora do quadro, id duplicado e tipo desconhecido apontam o bloco', () => {
    const doc = piece();
    doc.blocks[0] = { ...doc.blocks[0], rect: { x: 0.9, y: 0, w: 0.3, h: 0.1 } } as never;
    doc.blocks.push({ ...doc.blocks[1], id: 'title' } as never);
    doc.blocks.push({
      id: 'x',
      type: 'sticker',
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      zIndex: 1,
    } as never);
    const issues = validatePieceDocument(doc);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'BLOCK_OUT_OF_FRAME', blockId: 'logo' }),
        expect.objectContaining({ code: 'BLOCK_DUPLICATE_ID', blockId: 'title' }),
        expect.objectContaining({ code: 'BLOCK_TYPE_INVALID', blockId: 'x' }),
      ]),
    );
  });

  it('personagem: obrigatório, único, ≥ 25% da largura, rosto do logo só com kit de logo, painel válido', () => {
    const none = piece();
    none.blocks = none.blocks.filter((b) => b.type !== 'character');
    expect(codes(validatePieceDocument(none))).toContain('CHARACTER_MISSING');

    const twice = piece();
    twice.blocks.push({ ...twice.blocks[4], id: 'character2' } as never);
    expect(codes(validatePieceDocument(twice))).toContain('CHARACTER_DUPLICATE');

    const small = piece();
    small.blocks[4] = { ...small.blocks[4], rect: { x: 0.6, y: 0.62, w: 0.2, h: 0.3 } } as never;
    expect(validatePieceDocument(small)).toEqual([
      expect.objectContaining({ code: 'CHARACTER_TOO_SMALL', blockId: 'character' }),
    ]);

    const logoFace = piece();
    logoFace.blocks[4] = { ...logoFace.blocks[4], mode: 'logo_face' } as never;
    expect(codes(validatePieceDocument(logoFace, { kitIdentityMode: 'generated' }))).toContain(
      'CHARACTER_LOGO_FACE_REQUIRES_LOGO_KIT',
    );
    expect(validatePieceDocument(logoFace, { kitIdentityMode: 'logo_as_is' })).toEqual([]);
    expect(validatePieceDocument(logoFace)).toEqual([]); // sem contexto não checa

    const panel = piece();
    panel.blocks[4] = { ...panel.blocks[4], panel: { shape: 'card', color: 'white' } } as never;
    expect(codes(validatePieceDocument(panel))).toContain('CHARACTER_PANEL_INVALID');
  });

  it('produtos: 2..12 na grade, nome legível, foto em /uploads, preço legível, falados ≤ 6 e ≥ 1', () => {
    const few = piece();
    (few.blocks[2] as never as { items: McPieceProductItem[] }).items = [item(1)];
    expect(codes(validatePieceDocument(few))).toContain('PRODUCTS_TOO_FEW');

    const many = piece();
    (many.blocks[2] as never as { items: McPieceProductItem[] }).items = Array.from(
      { length: MC_PIECE_MAX_PRODUCTS + 1 },
      (_, i) => item(i, { spoken: i < MC_PIECE_MAX_SPOKEN }),
    );
    expect(codes(validatePieceDocument(many))).toContain('PRODUCTS_TOO_MANY');

    const bad = piece();
    (bad.blocks[2] as never as { items: McPieceProductItem[] }).items = [
      item(1, { name: 'WhatsApp Image 2026 10 21 at 20.28.14' }),
      item(2, { imageUrl: 'https://cdn.example.com/x.png' }),
      item(3, { imageUrl: '' }),
      item(4, { price: 'vinte' }),
      item(5, { originalPrice: 'R$ x' }),
      item(5),
    ];
    const issues = validatePieceDocument(bad);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PRODUCT_NAME_UNREADABLE', itemId: 'p1' }),
        expect.objectContaining({ code: 'PRODUCT_IMAGE_URL', itemId: 'p2' }),
        expect.objectContaining({ code: 'PRODUCT_IMAGE_REQUIRED', itemId: 'p3' }),
        expect.objectContaining({ code: 'PRODUCT_PRICE_INVALID', itemId: 'p4' }),
        expect.objectContaining({ code: 'PRODUCT_ORIGINAL_PRICE_INVALID', itemId: 'p5' }),
        expect.objectContaining({ code: 'PRODUCT_DUPLICATE_ID', itemId: 'p5' }),
      ]),
    );

    const spoken = piece();
    (spoken.blocks[2] as never as { items: McPieceProductItem[] }).items = Array.from(
      { length: 8 },
      (_, i) => item(i),
    );
    expect(codes(validatePieceDocument(spoken))).toContain('SPOKEN_TOO_MANY');

    const silent = piece();
    (silent.blocks[2] as never as { items: McPieceProductItem[] }).items = [
      item(1, { spoken: false }),
      item(2, { spoken: false }),
    ];
    expect(codes(validatePieceDocument(silent))).toContain('SPOKEN_NONE');
  });

  it('layout manual exige posição por produto, dentro do quadro', () => {
    const manual = piece();
    const block = manual.blocks[2] as never as { layout: string; items: McPieceProductItem[] };
    block.layout = 'manual';
    block.items = [
      item(1, { rect: { x: 0.05, y: 0.2, w: 0.4, h: 0.25 } }),
      item(2, { rect: { x: 0.9, y: 0.2, w: 0.4, h: 0.25 } }),
      item(3),
    ];
    expect(validatePieceDocument(manual)).toEqual([
      expect.objectContaining({ code: 'PRODUCT_OUT_OF_FRAME', itemId: 'p2' }),
      expect.objectContaining({ code: 'PRODUCT_RECT_MISSING', itemId: 'p3' }),
    ]);
  });

  it('imagem única: foto obrigatória, até 3 citados, sem mínimo de produtos', () => {
    const single = piece();
    const block = single.blocks[2] as never as Record<string, unknown>;
    block.mode = 'single';
    block.items = [item(1)];
    expect(codes(validatePieceDocument(single))).toEqual(['SINGLE_IMAGE_REQUIRED']);
    block.singleImageUrl = '/uploads/gallery/mix.png';
    expect(validatePieceDocument(single)).toEqual([]);
    block.items = [item(1), item(2), item(3), item(4)];
    expect(codes(validatePieceDocument(single))).toEqual(['PRODUCTS_TOO_MANY']);
  });

  it('textos: até 5, não vazios, fonte da conta, cor e tamanho válidos', () => {
    const doc = piece();
    for (let i = 0; i < MC_PIECE_MAX_TEXTS; i += 1) {
      doc.blocks.push({ ...doc.blocks[1], id: `t${i}` } as never);
    }
    expect(codes(validatePieceDocument(doc))).toContain('TEXTS_TOO_MANY');

    const text = piece();
    text.blocks[1] = {
      ...text.blocks[1],
      text: '  ',
      fontSize: 0.9,
      color: 'red',
      fontFamily: 'Comic',
    } as never;
    expect(codes(validatePieceDocument(text, { fontFamilies: ['Montserrat'] }))).toEqual(
      expect.arrayContaining([
        'TEXT_EMPTY',
        'TEXT_SIZE_INVALID',
        'TEXT_COLOR_INVALID',
        'FONT_UNKNOWN',
      ]),
    );
    expect(codes(validatePieceDocument(text))).not.toContain('FONT_UNKNOWN'); // sem lista não checa
  });

  it('rodapé: cores e validade completa', () => {
    const doc = piece();
    doc.blocks[3] = {
      ...doc.blocks[3],
      backgroundColor: 'blue',
      validity: { from: '2026-04-14', to: '' },
    } as never;
    expect(codes(validatePieceDocument(doc))).toEqual(
      expect.arrayContaining(['FOOTER_COLOR_INVALID', 'FOOTER_VALIDITY_INVALID']),
    );
  });

  it('tamanho do descritor é medido em bytes UTF-8', () => {
    expect(pieceDocumentBytes(piece())).toBeLessThan(MC_PIECE_MAX_BYTES);
    expect(pieceDocumentBytes(piece())).toBe(Buffer.byteLength(JSON.stringify(piece())));
  });
});

describe('mc-piece — hash canônico, ofertas faladas, cliente, modelo e escopo de mudança', () => {
  it('hash não depende da ordem das chaves nem de espaços extras', () => {
    const a = piece();
    const b = JSON.parse(JSON.stringify(a)) as McPieceDocument;
    b.blocks = b.blocks.map((block) => {
      const entries = Object.entries(block).reverse();
      return Object.fromEntries(entries) as never;
    });
    (b.blocks[1] as never as { text: string }).text = 'Qualidade  e variedade   todos os dias';
    expect(pieceCanonicalHash(b)).toBe(pieceCanonicalHash(a));
    (b.blocks[1] as never as { text: string }).text = 'Outra chamada';
    expect(pieceCanonicalHash(b)).not.toBe(pieceCanonicalHash(a));
  });

  it('ofertas faladas saem na ordem da peça, só as marcadas, como McSealProduct', () => {
    const doc = piece();
    (doc.blocks[2] as never as { items: McPieceProductItem[] }).items = [
      item(3, { spoken: false }),
      item(1),
      item(2, { originalPrice: '3,49', unit: 'kg' }),
    ];
    expect(pieceSpokenOffers(doc)).toEqual([
      {
        id: 'p1',
        catalogId: 'cat-1',
        name: 'Produto 1 especial',
        price: '2,99',
        originalPrice: null,
        unit: 'un',
        imageUrl: '/uploads/gallery/p1.png',
      },
      {
        id: 'p2',
        catalogId: 'cat-2',
        name: 'Produto 2 especial',
        price: '3,99',
        originalPrice: '3,49',
        unit: 'kg',
        imageUrl: '/uploads/gallery/p2.png',
      },
    ]);
    expect(pieceSpokenOffers({ ...doc, blocks: [] })).toEqual([]);
  });

  it('applyClientToPiece troca logo e rodapé e cria a logo quando falta', () => {
    const applied = applyClientToPiece(piece(), {
      logoUrl: '/uploads/logos/b.png',
      address: 'Rua Nova, 1',
      phone: '(11) 90000-0000',
    });
    expect(applied.blocks[0]).toMatchObject({ type: 'logo', imageUrl: '/uploads/logos/b.png' });
    expect(applied.blocks[3]).toMatchObject({
      type: 'footer',
      address: 'Rua Nova, 1',
      phone: '(11) 90000-0000',
    });
    expect(applied.blocks[1]).toEqual(piece().blocks[1]); // texto intocado

    const noLogo = piece();
    noLogo.blocks = noLogo.blocks.filter((b) => b.type !== 'logo');
    const created = applyClientToPiece(noLogo, { logoUrl: '/uploads/logos/c.png' });
    const logo = created.blocks.find((b) => b.type === 'logo');
    expect(logo).toMatchObject({ imageUrl: '/uploads/logos/c.png', zIndex: 5 });
    expect(applyClientToPiece(noLogo, {}).blocks.some((b) => b.type === 'logo')).toBe(false);
  });

  it('templateFromPiece guarda o visual e tira o que é do cliente ou da semana', () => {
    const template = templateFromPiece(piece());
    expect(template.blocks[0]).toMatchObject({
      type: 'logo',
      imageUrl: null,
      rect: piece().blocks[0].rect,
    });
    expect(template.blocks[2]).toMatchObject({
      type: 'products',
      items: [],
      singleImageUrl: null,
      layout: 'auto',
    });
    expect(template.blocks[3]).toMatchObject({
      type: 'footer',
      address: null,
      phone: null,
      validity: null,
      style: 'bar',
    });
    expect(template.blocks[1]).toEqual(piece().blocks[1]);
    expect(template.background).toEqual(piece().background);
  });

  it('pieceChangeScope: nada, só visual, ou falado', () => {
    const base = piece();
    expect(pieceChangeScope(base, JSON.parse(JSON.stringify(base)))).toBe('none');

    const visual = piece();
    visual.background = { mode: 'solid', color: '#000000' };
    (visual.blocks[2] as never as { items: McPieceProductItem[] }).items[0].imageUrl =
      '/uploads/gallery/outra.png';
    (visual.blocks[2] as never as { items: McPieceProductItem[] }).items[1].grams = '1 kg';
    expect(pieceChangeScope(base, visual)).toBe('visual');

    const price = piece();
    (price.blocks[2] as never as { items: McPieceProductItem[] }).items[0].price = '9,99';
    expect(pieceChangeScope(base, price)).toBe('spoken');

    const order = piece();
    const items = (order.blocks[2] as never as { items: McPieceProductItem[] }).items;
    [items[0], items[1]] = [items[1], items[0]];
    expect(pieceChangeScope(base, order)).toBe('spoken');

    const unspoken = piece();
    (unspoken.blocks[2] as never as { items: McPieceProductItem[] }).items[3].spoken = false;
    expect(pieceChangeScope(base, unspoken)).toBe('spoken');
  });
});
