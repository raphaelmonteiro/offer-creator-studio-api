import { fixturePieceDocument } from './__fixtures__/mc-piece.fixtures';
import { pieceCanonicalHash, McPieceProductsBlock } from './mc-piece';
import {
  ComposeFfmpegHashInput,
  computeComposeFfmpegHash,
  computeRenderStillHash,
  RenderStillHashInput,
} from './mc-step-hashes';

/** Tarefas 6.1/6.5 — hash do quadro parado e o `pieceHash` no compose. */
describe('mc-step-hashes — quadro parado da peça de ofertas (render_still)', () => {
  const doc = fixturePieceDocument();
  const base: RenderStillHashInput = {
    pieceHash: pieceCanonicalHash(doc),
    aspectRatio: '9:16',
    compositionVersion: '0.1.0',
    renderer: 'remotion',
    fonts: [
      { family: 'Bebas Neue', url: '/uploads/fonts/bebas.ttf' },
      { family: 'Anton', url: '/uploads/fonts/anton.ttf' },
    ],
  };

  it('é estável, independe da ordem das fontes e muda com descritor, aspecto, versão, renderizador e fontes', () => {
    const h = computeRenderStillHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRenderStillHash({ ...base })).toBe(h);
    expect(computeRenderStillHash({ ...base, fonts: [...base.fonts].reverse() })).toBe(h);

    const edited = fixturePieceDocument();
    (edited.blocks[0] as McPieceProductsBlock).items[0].imageUrl = '/uploads/gallery/outra.png';
    expect(computeRenderStillHash({ ...base, pieceHash: pieceCanonicalHash(edited) })).not.toBe(h);
    expect(computeRenderStillHash({ ...base, aspectRatio: '4:5' })).not.toBe(h);
    expect(computeRenderStillHash({ ...base, compositionVersion: '0.2.0' })).not.toBe(h);
    expect(computeRenderStillHash({ ...base, renderer: 'mock' })).not.toBe(h);
    expect(
      computeRenderStillHash({
        ...base,
        fonts: [{ family: 'Anton', url: '/uploads/fonts/a2.ttf' }],
      }),
    ).not.toBe(h);
  });

  it('o descritor canônico ignora a ordem das chaves — a mesma peça gravada de outro jeito é o mesmo quadro', () => {
    const reordered = JSON.parse(
      JSON.stringify(doc, (_k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => b.localeCompare(a)))
          : v,
      ),
    );
    expect(pieceCanonicalHash(reordered)).toBe(pieceCanonicalHash(doc));
  });
});

describe('mc-step-hashes — compose_ffmpeg da peça (pieceHash)', () => {
  const compose: ComposeFfmpegHashInput = {
    clips: [
      { sceneId: 'a', finalAssetId: 'clip-a' },
      { sceneId: 'b', finalAssetId: 'clip-b' },
    ],
    backgroundArtAssetId: null,
    aspectRatio: '9:16',
    window: { x: 0.58, y: 0.6, w: 0.37, h: 0.28 },
    logoFace: false,
    backgroundColor: '#FFE082',
    gapMs: 200,
    captionsEnabled: false,
    endcard: 'Mercado',
    graphVersion: 2,
  };

  it('mudar só a peça refaz o compose; mudar só a fala (clipe) refaz o compose mas não o quadro', () => {
    const pieceA = pieceCanonicalHash(fixturePieceDocument());
    const edited = fixturePieceDocument();
    (edited.blocks[0] as McPieceProductsBlock).items[1].price = '2,99';
    const pieceB = pieceCanonicalHash(edited);

    const withA = computeComposeFfmpegHash({ ...compose, pieceHash: pieceA });
    expect(computeComposeFfmpegHash({ ...compose, pieceHash: pieceA })).toBe(withA);
    expect(computeComposeFfmpegHash({ ...compose, pieceHash: pieceB })).not.toBe(withA);
    // outra fala → outro clipe → outro compose; o quadro (render_still) não entra aqui
    expect(
      computeComposeFfmpegHash({
        ...compose,
        pieceHash: pieceA,
        clips: [compose.clips[0], { sceneId: 'b', finalAssetId: 'clip-b2' }],
      }),
    ).not.toBe(withA);
    const still = (pieceHash: string) =>
      computeRenderStillHash({
        pieceHash,
        aspectRatio: '9:16',
        compositionVersion: '0.1.0',
        renderer: 'mock',
        fonts: [],
      });
    expect(still(pieceA)).toBe(still(pieceA));
    expect(still(pieceA)).not.toBe(still(pieceB));
  });

  it('sem pieceHash (F1) o hash é o de antes: null, undefined e ausente são o mesmo compose', () => {
    const plain = computeComposeFfmpegHash(compose);
    expect(computeComposeFfmpegHash({ ...compose, pieceHash: null })).toBe(plain);
    expect(computeComposeFfmpegHash({ ...compose, pieceHash: undefined })).toBe(plain);
    expect(computeComposeFfmpegHash({ ...compose, pieceHash: 'abc' })).not.toBe(plain);
  });
});
