import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import {
  FFMPEG_FIXTURES_ENABLED,
  imageClip,
  inset,
  lumaAt,
  probe,
  psnrMasked,
  referenceLuma,
  rgbFrameAt,
  runComposePlan,
} from './__fixtures__/mc-ffmpeg-fixture.helpers';
import { deltaE76, hexToRgb, rgbToLab } from './mc-cutout-key';
import {
  buildArtBaseChain,
  buildComposeGraph,
  ComposeGraphInput,
  composeTimeline,
} from './mc-talking-art-graph';

/**
 * Fixture com FFmpeg REAL do recorte por cor-chave (video-mascote-transparente, D5/tarefa 1.7):
 * clipes de uma personagem sintética (corpo, mãos e cesta) sobre #00B140, codificados em H.264
 * yuv420p como os dos motores, compostos sobre uma arte em degradê. Mede, fora da silhueta, o
 * PSNR de luma contra a arte (≥ 40 dB) e, em toda a janela, os pixels da cor-chave (zero).
 * Roda SOMENTE com `MC_TEST_FFMPEG=1`.
 */
const describeIf = FFMPEG_FIXTURES_ENABLED ? describe : describe.skip;

const KEY = '#00B140';
const KEY_LAB = rgbToLab(...hexToRgb(KEY));
const MIN_PSNR_DB = 40;
const CLIP_W = 720;
const CLIP_H = 1440;
const BASKET = [0x8b, 0x45, 0x13];
/** Folga (px) em volta da silhueta: antialias, matte suavizado e ringing do encoder. */
const SILHOUETTE_MARGIN_PX = 10;

const figureSvg = (withBackground: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CLIP_W}" height="${CLIP_H}">` +
  (withBackground ? `<rect width="100%" height="100%" fill="${KEY}"/>` : '') +
  '<circle cx="360" cy="320" r="180" fill="#E0A070"/>' +
  '<rect x="270" y="500" width="180" height="520" fill="#2255CC"/>' +
  '<rect x="270" y="1020" width="70" height="330" fill="#1A2F7A"/>' +
  '<rect x="380" y="1020" width="70" height="330" fill="#1A2F7A"/>' +
  '<rect x="450" y="640" width="150" height="50" fill="#E0A070"/>' +
  '<rect x="150" y="640" width="120" height="50" fill="#E0A070"/>' +
  `<rect x="540" y="690" width="120" height="100" fill="rgb(${BASKET.join(',')})"/>` +
  '</svg>';

const artSvg = (w: number, h: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1E3C72"/>' +
  '<stop offset="1" stop-color="#7A2A8E"/></linearGradient></defs>' +
  '<rect width="100%" height="100%" fill="url(#g)"/>' +
  `<rect x="40" y="40" width="${w - 80}" height="150" rx="18" fill="#C8102E"/>` +
  '<text x="70" y="140" font-family="DejaVu Sans" font-weight="bold" font-size="70" fill="#fff">OFERTAS</text>' +
  '</svg>';

describeIf('compose_ffmpeg com recorte por cor-chave, ffmpeg real (MC_TEST_FFMPEG=1)', () => {
  const W = 1080;
  const H = 1350;
  let dir: string;
  let run: {
    input: ComposeGraphInput;
    out: string;
    windowPx: Rect4;
    timeline: ReturnType<typeof composeTimeline>;
  };
  let mask: Uint8Array;
  let fitted: { x: number; y: number; width: number; height: number };

  type Rect4 = { x: number; y: number; width: number; height: number };

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cutout-'));
    const art = path.join(dir, 'art.png');
    await sharp(Buffer.from(artSvg(W, H)))
      .png()
      .toFile(art);
    const fig = path.join(dir, 'fig.png');
    await sharp(Buffer.from(figureSvg(true)))
      .png()
      .toFile(fig);
    const clips = [
      { sceneId: 'a', file: path.join(dir, 'a.mp4'), s: 1.0 },
      { sceneId: 'b', file: path.join(dir, 'b.mp4'), s: 1.2 },
    ];
    for (const c of clips) await imageClip(c.file, fig, c.s);
    const measured = [];
    for (const c of clips) {
      measured.push({ sceneId: c.sceneId, durationMs: (await probe(c.file)).durationMs as number });
    }
    const timeline = composeTimeline(measured, 200);
    const input: ComposeGraphInput = {
      format: 'offer_piece',
      aspectRatio: '4:5',
      width: W,
      height: H,
      backgroundArtPath: art,
      artWidth: W,
      artHeight: H,
      window: { x: 0.05, y: 0.45, w: 0.45, h: 0.5 },
      logoFace: false,
      backgroundColor: '#112233',
      clips: clips.map((c, i) => ({
        sceneId: c.sceneId,
        path: c.file,
        startS: timeline.clips[i].startS,
        endS: timeline.clips[i].endS,
      })),
      gapMs: 200,
      captionsEnabled: false,
      endcard: null,
      cutout: { keyColor: KEY, framing: 'corpo' },
    };
    const work = path.join(dir, 'work');
    await fs.mkdir(work, { recursive: true });
    const plan = buildComposeGraph(input, work);
    await runComposePlan(plan);
    run = { input, out: plan.output, windowPx: plan.windowPx, timeline };

    // silhueta no quadro: a figura sem fundo, encaixada (contain, colada embaixo) e dilatada
    const wp = plan.windowPx;
    const s = Math.min(wp.width / CLIP_W, wp.height / CLIP_H);
    fitted = {
      width: Math.round(CLIP_W * s),
      height: Math.round(CLIP_H * s),
      x: wp.x + Math.round((wp.width - CLIP_W * s) / 2),
      y: wp.y + (wp.height - Math.round(CLIP_H * s)),
    };
    const alpha = await sharp(Buffer.from(figureSvg(false)))
      .resize(fitted.width, fitted.height)
      .ensureAlpha()
      .extractChannel(3)
      .blur(SILHOUETTE_MARGIN_PX / 2)
      .threshold(4)
      .raw()
      .toBuffer();
    mask = new Uint8Array(W * H);
    for (let y = 0; y < fitted.height; y += 1) {
      for (let x = 0; x < fitted.width; x += 1) {
        if (alpha[y * fitted.width + x] > 0) mask[(fitted.y + y) * W + fitted.x + x] = 1;
      }
    }
  }, 240_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Retângulos 1×1 sobre cada pixel da silhueta dilatada seriam caros: máscara por linha (runs). */
  function silhouetteRuns(): Rect4[] {
    const runs: Rect4[] = [];
    for (let y = 0; y < H; y += 1) {
      let x = 0;
      while (x < W) {
        if (!mask[y * W + x]) {
          x += 1;
          continue;
        }
        const start = x;
        while (x < W && mask[y * W + x]) x += 1;
        runs.push({ x: start, y, width: x - start, height: 1 });
      }
    }
    return runs;
  }

  it('fora da silhueta a janela coincide com a arte (PSNR de luma ≥ 40 dB) em quadros das duas falas', async () => {
    const ref = await referenceLuma(
      run.input.backgroundArtPath as string,
      buildArtBaseChain(run.input),
      W,
      H,
    );
    const runs = silhouetteRuns();
    const region = inset(run.windowPx, 2);
    for (const t of [0.5, run.timeline.clips[1].startS + 0.5]) {
      const frame = await lumaAt(run.out, t, W, H);
      const { psnr, pixels } = psnrMasked(frame, ref, W, region, runs);
      expect(pixels).toBeGreaterThan(region.width * region.height * 0.3);
      expect(psnr).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    }
  }, 120_000);

  it('nenhum pixel da cor-chave (ΔE ≤ 25) em toda a janela, nos quadros das duas falas', async () => {
    const wp = run.windowPx;
    for (const t of [0.5, run.timeline.clips[1].startS + 0.5]) {
      const rgb = await rgbFrameAt(run.out, t, W, H);
      let keyed = 0;
      for (let y = wp.y; y < wp.y + wp.height; y += 1) {
        for (let x = wp.x; x < wp.x + wp.width; x += 1) {
          const i = (y * W + x) * 3;
          if (deltaE76(rgbToLab(rgb[i], rgb[i + 1], rgb[i + 2]), KEY_LAB) <= 25) keyed += 1;
        }
      }
      expect(keyed).toBe(0);
    }
  }, 120_000);

  it('mãos e objeto segurado aparecem inteiros dentro da janela (cesta com ≥ 80% da área esperada)', async () => {
    const s = fitted.width / CLIP_W;
    const expected = 120 * 100 * s * s;
    const rgb = await rgbFrameAt(run.out, 0.5, W, H);
    let basket = 0;
    const wp = run.windowPx;
    for (let y = wp.y; y < wp.y + wp.height; y += 1) {
      for (let x = wp.x; x < wp.x + wp.width; x += 1) {
        const i = (y * W + x) * 3;
        if (
          Math.abs(rgb[i] - BASKET[0]) < 12 &&
          Math.abs(rgb[i + 1] - BASKET[1]) < 12 &&
          Math.abs(rgb[i + 2] - BASKET[2]) < 12
        ) {
          basket += 1;
        }
      }
    }
    expect(basket).toBeGreaterThanOrEqual(expected * 0.8);
    // a figura cabe: nada passa da janela e a personagem fica colada embaixo
    expect(fitted.y + fitted.height).toBe(run.windowPx.y + run.windowPx.height);
  }, 120_000);
});
