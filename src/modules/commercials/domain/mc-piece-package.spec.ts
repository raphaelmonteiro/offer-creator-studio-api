import {
  COMPOSITION_VERSION,
  OFFER_CAROUSEL_COMPOSITION_ID,
  OFFER_PIECE_STILL_COMPOSITION_ID,
  layoutProducts,
  parseOfferPieceStillProps,
  parsePieceDocument,
} from '@chroma/video-templates/core';
import { McPieceDocument, pieceBlock, validatePieceDocument } from './mc-piece';
import { buildMockStillPlan, buildOfferPieceStillProps } from './mc-piece-still-props';
import {
  MC_DEFAULT_COMPOSITION_VERSION,
  MC_OFFER_CAROUSEL_COMPOSITION_ID,
  MC_OFFER_PIECE_STILL_COMPOSITION_ID,
} from './mc-render.config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pieceFixture = require('@chroma/video-templates/fixtures/piece-9x16.json') as {
  width: number;
  height: number;
  document: McPieceDocument;
};

/** A fixture do pacote com as fotos onde o backend exige (`/uploads/`). */
function fixtureDocument(): McPieceDocument {
  const document = JSON.parse(JSON.stringify(pieceFixture.document)) as McPieceDocument;
  for (const block of document.blocks) {
    if (block.type === 'logo' && block.imageUrl) block.imageUrl = `/uploads/${block.imageUrl}`;
    if (block.type === 'products') {
      block.items.forEach((item) => {
        item.imageUrl = `/uploads/${item.imageUrl}`;
      });
    }
  }
  return document;
}

/**
 * Contrato com o pacote `@chroma/video-templates` (change video-peca-configuravel,
 * grupo 3): ids e versão da composição iguais aos daqui, a fixture compartilhada
 * (`fixtures/piece-9x16.json`) é uma peça válida pelas regras do backend, e as props
 * que o worker monta passam no schema que a composição aplica no `calculateMetadata`.
 */
describe('mc-piece-package — contrato com @chroma/video-templates', () => {
  it('ids das composições e versão padrão iguais aos do pacote', () => {
    expect(MC_OFFER_CAROUSEL_COMPOSITION_ID).toBe(OFFER_CAROUSEL_COMPOSITION_ID);
    expect(MC_OFFER_PIECE_STILL_COMPOSITION_ID).toBe(OFFER_PIECE_STILL_COMPOSITION_ID);
    expect(MC_DEFAULT_COMPOSITION_VERSION).toBe(COMPOSITION_VERSION);
  });

  it('a fixture do pacote é um descritor válido para o schema e, com fotos em /uploads/, para as regras do backend', () => {
    expect(parsePieceDocument(pieceFixture.document).success).toBe(true);
    const document = fixtureDocument();
    expect(validatePieceDocument(document)).toEqual([]);
    expect(pieceBlock(document, 'products')?.items.filter((i) => i.spoken)).toHaveLength(4);
  });

  it('as props do worker (URLs absolutas) passam no schema do pacote; /uploads/ cru não passa', () => {
    const document = fixtureDocument();
    const { props } = buildOfferPieceStillProps({
      document,
      width: pieceFixture.width,
      height: pieceFixture.height,
      fonts: [{ family: 'Bebas Neue', url: '/uploads/fonts/bebas.ttf' }],
      assetBaseUrl: 'http://127.0.0.1:3001',
    });
    const parsed = parseOfferPieceStillProps(props);
    expect(parsed.success).toBe(true);
    const raw = parseOfferPieceStillProps({
      document,
      width: pieceFixture.width,
      height: pieceFixture.height,
      fonts: [],
    });
    expect(raw.success).toBe(false);
    // dimensões erradas para o formato também são recusadas pelo pacote
    expect(parseOfferPieceStillProps({ ...props, height: 1350 }).success).toBe(false);
  });

  it('o quadro mock desenha as células do MESMO layoutProducts do pacote (destaque em 2 colunas)', () => {
    const document = fixtureDocument();
    const products = pieceBlock(document, 'products');
    expect(products).not.toBeNull();
    const { props } = buildOfferPieceStillProps({
      document,
      width: 1080,
      height: 1920,
      fonts: [],
      assetBaseUrl: 'http://127.0.0.1:3001',
    });
    const plan = buildMockStillPlan(props);
    const layout = layoutProducts({
      areaRect: products.rect,
      width: 1080,
      height: 1920,
      itemIds: products.items.map((i) => i.id),
      featuredId: 'it-picanha',
    });
    expect([layout.cols, layout.rows]).toEqual([3, 3]);
    const featured = layout.rects['it-picanha'];
    const x = Math.round(featured.x * 1080);
    const y = Math.round(featured.y * 1920);
    const width = Math.round((featured.x + featured.w) * 1080) - x;
    expect(plan.overlaySvg).toContain(`<rect x="${x}" y="${y}" width="${width}"`);
  });
});
