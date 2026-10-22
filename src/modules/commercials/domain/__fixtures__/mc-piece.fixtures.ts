import {
  defaultPieceDocument,
  McPieceAspectRatio,
  McPieceCharacterBlock,
  McPieceDocument,
  McPieceProductItem,
  McPieceProductsBlock,
} from '../mc-piece';

/**
 * Peça de ofertas PRONTA para produção (change video-peca-configuravel):
 * 4 produtos (3 falados), rodapé com validade, personagem em painel liso.
 * Base dos specs do roteiro, do quadro parado, da cadeia e do compose.
 */
export function fixturePieceDocument(
  opts: {
    aspectRatio?: McPieceAspectRatio;
    character?: Partial<McPieceCharacterBlock>;
    items?: McPieceProductItem[];
    background?: McPieceDocument['background'];
    texts?: Array<{ text: string; fontFamily?: string | null }>;
  } = {},
): McPieceDocument {
  const doc = defaultPieceDocument(opts.aspectRatio ?? '9:16');
  if (opts.background) doc.background = opts.background;
  const products = doc.blocks[0] as McPieceProductsBlock;
  products.items = opts.items ?? [
    {
      id: 'it-picanha',
      catalogId: 'cat-1',
      name: 'Picanha bovina',
      price: '59,90',
      unit: 'kg',
      imageUrl: '/uploads/gallery/picanha.png',
      spoken: true,
    },
    {
      id: 'it-cerveja',
      name: 'Cerveja lata 350 ml',
      price: '3,49',
      originalPrice: '4,29',
      unit: 'un',
      imageUrl: '/uploads/gallery/cerveja.png',
      spoken: false,
    },
    {
      id: 'it-arroz',
      name: 'Arroz tipo 1 5 kg',
      price: '24,90',
      imageUrl: '/uploads/gallery/arroz.png',
      spoken: true,
    },
    {
      id: 'it-refri',
      name: 'Refrigerante 2 L',
      price: '7,99',
      imageUrl: '/uploads/gallery/refri.png',
      spoken: true,
    },
  ];
  const footer = doc.blocks[1] as Extract<McPieceDocument['blocks'][number], { type: 'footer' }>;
  footer.validity = { from: '2026-04-14', to: '2026-04-16' };
  footer.address = 'Rua das Flores, 100';
  footer.phone = '(11) 99999-0000';
  doc.blocks.push({
    id: 'logo',
    type: 'logo',
    rect: { x: 0.05, y: 0.03, w: 0.3, h: 0.1 },
    zIndex: 3,
    imageUrl: '/uploads/logos/cliente.png',
  });
  (opts.texts ?? []).forEach((t, i) =>
    doc.blocks.push({
      id: `text-${i}`,
      type: 'text',
      rect: { x: 0.4, y: 0.04 + i * 0.06, w: 0.55, h: 0.05 },
      zIndex: 3,
      text: t.text,
      fontFamily: t.fontFamily ?? null,
      fontSize: 0.04,
      color: '#111827',
      align: 'left',
      weight: 'bold',
    }),
  );
  doc.blocks.push({
    id: 'character',
    type: 'character',
    rect: { x: 0.58, y: 0.6, w: 0.37, h: 0.28 },
    zIndex: 4,
    kitId: 'kit-1',
    mode: 'in_piece',
    panel: { shape: 'card', color: '#FFE082' },
    ...opts.character,
  });
  return doc;
}
