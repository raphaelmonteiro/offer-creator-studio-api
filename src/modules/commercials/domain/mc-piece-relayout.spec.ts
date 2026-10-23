import { layoutProducts } from '@chroma/video-templates/core';
import { fixturePieceDocument } from './__fixtures__/mc-piece.fixtures';
import { McPieceProductsBlock, pieceBlock, validatePieceDocument } from './mc-piece';
import { pieceCopyName, relayoutPieceForAspect } from './mc-piece-relayout';

/** Tarefa 5.5 — a peça reorganizada em outro formato, sem esticar nada. */
describe('relayoutPieceForAspect', () => {
  it('9:16 → 4:5: grade volta a auto sem rects, demais blocos mantêm as frações; peça continua válida', () => {
    const source = fixturePieceDocument();
    const products = pieceBlock(source, 'products') as McPieceProductsBlock;
    products.layout = 'manual';
    products.items.forEach((item, i) => {
      item.rect = { x: 0.05 + i * 0.2, y: 0.25, w: 0.18, h: 0.2 };
    });
    products.items[0].featured = true;

    const result = relayoutPieceForAspect(source, '4:5');
    expect(result.changed).toBe(true);
    expect(result.document.aspectRatio).toBe('4:5');
    const copy = pieceBlock(result.document, 'products') as McPieceProductsBlock;
    expect(copy.layout).toBe('auto');
    copy.items.forEach((item) => expect(item).not.toHaveProperty('rect'));
    expect(copy.items.map((i) => i.id)).toEqual(products.items.map((i) => i.id));
    expect(copy.items[0].featured).toBe(true);
    // logo, rodapé e personagem: as mesmas frações
    for (const type of ['logo', 'footer', 'character'] as const) {
      expect(pieceBlock(result.document, type)?.rect).toEqual(pieceBlock(source, type)?.rect);
    }
    // a grade informada é a do pacote para 1080×1350 (4 itens com destaque → 2 colunas)
    const expected = layoutProducts({
      areaRect: copy.rect,
      width: 1080,
      height: 1350,
      itemIds: copy.items.map((i) => i.id),
      featuredId: copy.items[0].id,
    });
    expect(result.layout).toEqual({
      cols: expected.cols,
      rows: expected.rows,
      cellPx: expected.cellPx,
      textScale: expected.textScale,
    });
    expect(validatePieceDocument(result.document)).toEqual([]);
    // a origem não foi tocada
    expect(source.aspectRatio).toBe('9:16');
    expect(products.layout).toBe('manual');
    expect(products.items[0].rect).toBeDefined();
  });

  it('mesmo formato: cópia fiel (layout manual preservado), changed=false', () => {
    const source = fixturePieceDocument();
    const products = pieceBlock(source, 'products') as McPieceProductsBlock;
    products.layout = 'manual';
    products.items.forEach((item) => {
      item.rect = { x: 0.1, y: 0.3, w: 0.3, h: 0.2 };
    });
    const result = relayoutPieceForAspect(source, '9:16');
    expect(result.changed).toBe(false);
    expect(result.layout).toBeNull();
    expect(result.document).toEqual(source);
    expect(result.document).not.toBe(source);
  });

  it('imagem única ou grade vazia: formato trocado, sem grade calculada', () => {
    const single = fixturePieceDocument();
    const block = pieceBlock(single, 'products') as McPieceProductsBlock;
    block.mode = 'single';
    block.singleImageUrl = '/uploads/gallery/mesa.png';
    const result = relayoutPieceForAspect(single, '4:5');
    expect(result.changed).toBe(true);
    expect(result.layout).toBeNull();
    expect(result.document.aspectRatio).toBe('4:5');

    const empty = fixturePieceDocument({ items: [] });
    expect(relayoutPieceForAspect(empty, '4:5').layout).toBeNull();
  });

  it('nome da peça clonada ganha o formato, sem empilhar sufixos e sem passar de 120', () => {
    expect(pieceCopyName('Ofertas da semana', '4:5')).toBe('Ofertas da semana (4:5)');
    expect(pieceCopyName('Ofertas da semana (9:16)', '4:5')).toBe('Ofertas da semana (4:5)');
    expect(pieceCopyName('x'.repeat(130), '9:16')).toHaveLength(120);
    expect(pieceCopyName('x'.repeat(130), '9:16').endsWith(' (9:16)')).toBe(true);
  });
});
