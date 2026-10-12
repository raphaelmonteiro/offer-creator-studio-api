import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MockCarouselRenderer } from '../services/mc-carousel-renderer';
import { fixtureCarouselScript } from './__fixtures__/mc-offer-carousel.fixtures';
import {
  ffmpeg,
  FFMPEG_FIXTURES_ENABLED,
  meanRgbAt,
  probe,
  tinyClip,
} from './__fixtures__/mc-ffmpeg-fixture.helpers';
import { syntheticAlignment } from './mc-captions';
import { buildMockCarouselPlan, mockSlideWindows } from './mc-carousel-mock-graph';
import { buildOfferCarouselProps, carouselFractionsToPx } from './mc-offer-carousel-props';

/**
 * Fixture com FFmpeg REAL do renderizador mock do F2 (tarefa 6.5): 3 ofertas,
 * 5 falas (clipes minúsculos de cor sólida + tom, no aspecto do tile 3:4) →
 * MP4 1080×1920 com o personagem na janela do preset, o card branco com o
 * texto de cada oferta, a cor de marca no fundo, o TTS mixado e a cartela de
 * 1,5 s. Roda SOMENTE com `MC_TEST_FFMPEG=1` (container: `docker exec -e
 * MC_TEST_FFMPEG=1 chroma_backend npx jest mc-carousel-render.fixture`).
 */
const describeIf = FFMPEG_FIXTURES_ENABLED ? describe : describe.skip;

const COLORS = ['red', 'lime', 'blue', 'yellow', 'magenta'];
const DURATIONS = [1.0, 1.2, 1.1, 1.3, 0.9];

describeIf('render mock do F2 com ffmpeg real (MC_TEST_FFMPEG=1)', () => {
  let dir: string;
  const measurements: Record<string, unknown> = {};

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-f2-render-'));
    for (const [i, color] of COLORS.entries()) {
      await tinyClip(path.join(dir, `clip-${i}.mp4`), DURATIONS[i], color, {
        frequency: 300 + i * 100,
      });
    }
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(`[F2 mock render fixture] ${JSON.stringify(measurements)}`);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('MP4 1080×1920 com personagem na janela, cards por oferta, fundo da marca, TTS e cartela', async () => {
    const script = fixtureCarouselScript(3);
    const lines = script.lines ?? [];
    const speeches = [];
    const localFiles: Record<string, string> = {};
    for (const [i, line] of lines.entries()) {
      const file = path.join(dir, `clip-${i}.mp4`);
      const p = await probe(file);
      const scene = script.scenes.find((s) => s.sceneId === line.sceneId)!;
      speeches.push({
        sceneId: line.sceneId,
        durationMs: p.durationMs as number,
        clipUrl: `/uploads/f2/clip-${i}.mp4`,
        alignment: syntheticAlignment(scene.dialogue as string, (p.durationMs as number) / 1000),
      });
      localFiles[`http://127.0.0.1:3001/uploads/f2/clip-${i}.mp4`] = file;
    }
    const { props, timeline } = buildOfferCarouselProps({
      aspectRatio: '9:16',
      offers: script.offers ?? [],
      lines,
      speeches,
      layoutPreset: 'character_left',
      captions: true,
      tile: { width: 720, height: 960, url: null },
      characterBackgroundColor: '#FFE082',
      brand: { name: 'Mercadão' },
      assetBaseUrl: 'http://127.0.0.1:3001',
    });
    const renderer = new MockCarouselRenderer({
      run: async (args, opts) => {
        await ffmpeg(args);
        await opts.onProgress?.(100); // o FfmpegRunner real reporta pelo -progress
      },
    });
    const work = path.join(dir, 'job');
    await fs.mkdir(work, { recursive: true });
    const output = path.join(work, 'rendered.mp4');
    const progress: number[] = [];
    const result = await renderer.render({
      props,
      localFiles,
      outputPath: output,
      tempDir: work,
      onProgress: (pct) => {
        progress.push(pct);
      },
    });
    expect(result).toMatchObject({
      outputPath: output,
      renderer: 'mock',
      compositionVersion: '0.1.0',
    });

    const out = await probe(output);
    measurements.durationMs = out.durationMs;
    measurements.expectedMs = Math.round(timeline.totalS * 1000);
    expect(out).toMatchObject({ hasVideo: true, hasAudio: true, width: 1080, height: 1920 });
    expect(Math.abs((out.durationMs as number) - timeline.totalS * 1000)).toBeLessThanOrEqual(250);
    expect(out.audioRate).toBe(48000);

    const plan = buildMockCarouselPlan({
      props,
      clipPaths: lines.map((_, i) => path.join(dir, `clip-${i}.mp4`)),
      tempDir: work,
    });
    const slides = mockSlideWindows(props, timeline.totalS);
    // janela: o clipe 2 (lime) no meio da fala 2
    const win = carouselFractionsToPx(props.character.window, 1080, 1920);
    const inner = { x: win.x + 40, y: win.y + 40, width: 40, height: 40 };
    const mid = (i: number) => (props.lines[i].startS + props.lines[i].endS) / 2;
    const [r1, g1, b1] = await meanRgbAt(output, mid(1), inner);
    measurements.windowRgb = [r1, g1, b1];
    expect(g1).toBeGreaterThan(150);
    expect(r1).toBeLessThan(90);
    expect(b1).toBeLessThan(90);
    // card branco (canto superior direito, longe do texto) durante a oferta 2
    const card = plan.cardPx;
    const cardCorner = { x: card.x + card.width - 70, y: card.y + 30, width: 40, height: 40 };
    const offerSlide = slides.find((s) => s.id === 'of-cafe')!;
    const cardRgb = await meanRgbAt(output, (offerSlide.startS + offerSlide.endS) / 2, cardCorner);
    measurements.cardRgb = cardRgb;
    expect(Math.min(...cardRgb)).toBeGreaterThan(225);
    // fundo da marca (#C62828) fora do card e da janela
    const bg = await meanRgbAt(output, mid(2), { x: 10, y: 10, width: 40, height: 40 });
    measurements.backgroundRgb = bg;
    expect(bg[0]).toBeGreaterThan(160);
    expect(bg[1]).toBeLessThan(80);
    // cartela: depois da última fala o último quadro do personagem (magenta) segue na janela
    const tail = await meanRgbAt(output, timeline.speechEndS + 0.8, inner);
    measurements.tailRgb = tail;
    expect(tail[0]).toBeGreaterThan(150);
    expect(tail[2]).toBeGreaterThan(150);
    expect(tail[1]).toBeLessThan(90);
    // texto do card desenhado (a região do preço não é branca durante a oferta)
    const priceBand = {
      x: card.x + 20,
      y: Math.round(card.y + card.height * 0.64),
      width: card.width - 40,
      height: 40,
    };
    const priceRgb = await meanRgbAt(output, (offerSlide.startS + offerSlide.endS) / 2, priceBand);
    measurements.priceRgb = priceRgb;
    expect(Math.min(...priceRgb)).toBeLessThan(235);
    // badge "-18%" do café desenhado (caixa na cor da marca no canto do card)
    const badge = { x: card.x + 30, y: card.y + 30, width: 24, height: 16 };
    const badgeRgb = await meanRgbAt(output, (offerSlide.startS + offerSlide.endS) / 2, badge);
    measurements.badgeRgb = badgeRgb;
    expect(badgeRgb[0]).toBeGreaterThan(150);
    expect(badgeRgb[1]).toBeLessThan(120);
    // progresso acumulado dos dois passes chega a 100%
    expect(Math.round(progress[progress.length - 1])).toBe(100);
  }, 180_000);
});
