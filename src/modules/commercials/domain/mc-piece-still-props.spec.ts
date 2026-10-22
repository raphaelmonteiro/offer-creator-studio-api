import { fixturePieceDocument } from './__fixtures__/mc-piece.fixtures';
import { McPieceProductsBlock } from './mc-piece';
import {
  buildMockStillPlan,
  buildOfferPieceStillProps,
  mockGridCells,
  pieceMediaUrls,
  pieceRectToPx,
} from './mc-piece-still-props';

/** Tarefa 6.2 — props da composição `OfferPieceStill` e plano do mock (puro). */
describe('mc-piece-still-props — props do quadro parado', () => {
  it('lista as mídias da peça sem repetição (fundo, logo, fotos, imagem única)', () => {
    const doc = fixturePieceDocument({
      background: { mode: 'image', imageUrl: '/uploads/commercials/bg.jpg', fit: 'cover' },
    });
    (doc.blocks[0] as McPieceProductsBlock).singleImageUrl = '/uploads/gallery/picanha.png';
    expect(pieceMediaUrls(doc)).toEqual([
      '/uploads/commercials/bg.jpg',
      '/uploads/gallery/picanha.png',
      '/uploads/gallery/cerveja.png',
      '/uploads/gallery/arroz.png',
      '/uploads/gallery/refri.png',
      '/uploads/logos/cliente.png',
    ]);
  });

  it('torna absolutas as URLs de fundo, logo, fotos e fontes e devolve o mapa absoluta → original', () => {
    const doc = fixturePieceDocument({
      background: { mode: 'image', imageUrl: '/uploads/commercials/bg.jpg' },
      texts: [{ text: 'OFERTAS', fontFamily: 'Bebas Neue' }],
    });
    const { props, sources } = buildOfferPieceStillProps({
      document: doc,
      width: 1080,
      height: 1920,
      fonts: [{ family: 'Bebas Neue', url: '/uploads/fonts/bebas.ttf' }],
      assetBaseUrl: 'http://127.0.0.1:3001/',
    });
    expect(props).toMatchObject({ width: 1080, height: 1920 });
    expect(props.document.background).toEqual({
      mode: 'image',
      imageUrl: 'http://127.0.0.1:3001/uploads/commercials/bg.jpg',
    });
    const products = props.document.blocks.find(
      (b) => b.type === 'products',
    ) as McPieceProductsBlock;
    expect(products.items.map((i) => i.imageUrl)).toEqual([
      'http://127.0.0.1:3001/uploads/gallery/picanha.png',
      'http://127.0.0.1:3001/uploads/gallery/cerveja.png',
      'http://127.0.0.1:3001/uploads/gallery/arroz.png',
      'http://127.0.0.1:3001/uploads/gallery/refri.png',
    ]);
    expect(props.document.blocks.find((b) => b.type === 'logo')).toMatchObject({
      imageUrl: 'http://127.0.0.1:3001/uploads/logos/cliente.png',
    });
    expect(props.fonts).toEqual([
      { family: 'Bebas Neue', url: 'http://127.0.0.1:3001/uploads/fonts/bebas.ttf' },
    ]);
    expect(props.document.fonts).toEqual(props.fonts);
    expect(sources['http://127.0.0.1:3001/uploads/gallery/arroz.png']).toBe(
      '/uploads/gallery/arroz.png',
    );
    expect(sources['http://127.0.0.1:3001/uploads/fonts/bebas.ttf']).toBe(
      '/uploads/fonts/bebas.ttf',
    );
    // o descritor original não é alterado
    expect((doc.blocks[0] as McPieceProductsBlock).items[0].imageUrl).toBe(
      '/uploads/gallery/picanha.png',
    );
    // URL já absoluta ou data: fica como está
    const external = fixturePieceDocument();
    (external.blocks[0] as McPieceProductsBlock).items[0].imageUrl = 'https://cdn.x/p.png';
    expect(
      (
        buildOfferPieceStillProps({
          document: external,
          width: 1080,
          height: 1920,
          fonts: [],
          assetBaseUrl: 'http://127.0.0.1:3001',
        }).props.document.blocks[0] as McPieceProductsBlock
      ).items[0].imageUrl,
    ).toBe('https://cdn.x/p.png');
  });

  it('frações → pixels sem buracos entre células vizinhas; grade do mock cabe na área', () => {
    expect(pieceRectToPx({ x: 0.05, y: 0.2, w: 0.9, h: 0.52 }, 1080, 1920)).toEqual({
      x: 54,
      y: 384,
      width: 972,
      height: 998,
    });
    const area = { x: 54, y: 384, width: 972, height: 998 };
    for (const n of [1, 2, 3, 4, 6, 9, 12]) {
      const cells = mockGridCells(area, n);
      expect(cells).toHaveLength(n);
      for (const c of cells) {
        expect(c.x).toBeGreaterThanOrEqual(area.x);
        expect(c.y).toBeGreaterThanOrEqual(area.y);
        expect(c.x + c.width).toBeLessThanOrEqual(area.x + area.width);
        expect(c.y + c.height).toBeLessThanOrEqual(area.y + area.height);
      }
    }
    expect(mockGridCells(area, 0)).toEqual([]);
  });

  it('plano do mock: fundo sólido/degradê em SVG, imagem como referência; um desenho por bloco na ordem do zIndex', () => {
    const solid = buildMockStillPlan({
      document: fixturePieceDocument(),
      width: 1080,
      height: 1920,
      fonts: [],
    });
    expect(solid.backgroundSvg).toContain('fill="#F3F4F6"');
    expect(solid.backgroundImage).toBeNull();
    expect(solid.overlaySvg).toContain('LOGO');
    expect(solid.overlaySvg).toContain('Picanha bovina');
    expect(solid.overlaySvg).toContain('R$ 59,90/kg');
    expect(solid.overlaySvg).toContain('de R$ 4,29'); // preço anterior riscado
    expect(solid.overlaySvg).toContain('válido de 2026-04-14 a 2026-04-16');
    expect(solid.overlaySvg).toContain('fill="#FFE082"'); // painel do personagem
    // painel por último (zIndex 4) e depois do rodapé (2)
    expect(solid.overlaySvg.lastIndexOf('fill="#FFE082"')).toBeGreaterThan(
      solid.overlaySvg.indexOf('fill="#111827"'),
    );

    const gradient = buildMockStillPlan({
      document: fixturePieceDocument({
        background: { mode: 'gradient', colors: ['#D32F2F', '#F9A825'], angle: 90 },
      }),
      width: 1080,
      height: 1350,
      fonts: [],
    });
    expect(gradient.backgroundSvg).toContain('linearGradient');
    expect(gradient.backgroundSvg).toContain('stop-color="#D32F2F"');

    const image = buildMockStillPlan({
      document: fixturePieceDocument({
        background: {
          mode: 'image',
          imageUrl: 'http://x/uploads/bg.jpg',
          fit: 'contain',
          blur: 0.5,
          darken: 0.3,
        },
      }),
      width: 1080,
      height: 1920,
      fonts: [],
    });
    expect(image.backgroundSvg).toBeNull();
    expect(image.backgroundImage).toEqual({
      url: 'http://x/uploads/bg.jpg',
      fit: 'contain',
      blur: 0.5,
      darken: 0.3,
    });
  });

  it('texto com caracteres especiais é escapado; cor inválida cai no padrão; painel circular vira <circle>', () => {
    const doc = fixturePieceDocument({
      texts: [{ text: 'Arroz & Feijão <5kg>' }],
      character: { panel: { shape: 'circle', color: 'vermelho' } },
    });
    const plan = buildMockStillPlan({ document: doc, width: 1080, height: 1920, fonts: [] });
    expect(plan.overlaySvg).toContain('Arroz &amp; Feijão &lt;5kg&gt;');
    expect(plan.overlaySvg).toContain('<circle');
    expect(plan.overlaySvg).not.toContain('vermelho');
  });
});
