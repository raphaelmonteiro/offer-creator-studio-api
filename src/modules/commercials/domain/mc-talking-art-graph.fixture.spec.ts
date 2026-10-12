import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  FFMPEG_FIXTURES_ENABLED,
  inset,
  lumaAt,
  meanRgbAt,
  probe,
  psnrMasked,
  Rect,
  referenceLuma,
  runComposePlan,
  speechOnsets,
  syntheticArt,
  tinyClip,
} from './__fixtures__/mc-ffmpeg-fixture.helpers';
import { captionLayoutFor } from './mc-finalize-graph';
import {
  buildArtBaseChain,
  buildComposeGraph,
  ComposeGraphInput,
  composedOutputIssue,
  composeTimeline,
} from './mc-talking-art-graph';
import { artBoxToOutputWindow, defaultCharacterWindow } from './mc-talking-art-window';

/**
 * Fixture com FFmpeg REAL do compose do F1 (tarefa 4.4, spec "Fidelidade da
 * arte" / "Aspecto de saída"): arte sintética de encarte + clipes minúsculos
 * (cor sólida + tom) → composto; PSNR de luma da região da arte (janela e
 * faixa de legenda mascaradas) contra a arte passada pelo MESMO filtro de
 * base, aspectos 4:5, 1:1, 1:1 → 9:16 e 1280×928 → 16:9, offsets das falas,
 * crossfade, rosto do logo, preenchimento desfocado e cartela. Roda SOMENTE
 * com `MC_TEST_FFMPEG=1`; sem isso fica skipped — nunca "passa" por engano.
 */
const describeIf = FFMPEG_FIXTURES_ENABLED ? describe : describe.skip;

/** Limiar da spec "Fidelidade da arte". */
const MIN_PSNR_DB = 40;
/** Folga em volta da janela (bordas do overlay/ringing do encoder) e da borda da arte. */
const WINDOW_MARGIN_PX = 8;
const ART_EDGE_MARGIN_PX = 2;

interface Clip {
  sceneId: string;
  file: string;
  durationS: number;
  color: string;
}

describeIf('compose_ffmpeg com ffmpeg real — arte que fala (MC_TEST_FFMPEG=1)', () => {
  let dir: string;
  let clips: Clip[];
  const measurements: Record<string, unknown> = {};

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-f1-compose-'));
    clips = [
      { sceneId: 'a', file: path.join(dir, 'a.mp4'), durationS: 1.0, color: 'red' },
      { sceneId: 'b', file: path.join(dir, 'b.mp4'), durationS: 1.3, color: 'lime' },
    ];
    for (const clip of clips) await tinyClip(clip.file, clip.durationS, clip.color);
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(`[F1 compose fixture] ${JSON.stringify(measurements)}`);
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function compose(
    name: string,
    over: Partial<ComposeGraphInput> & { width: number; height: number; aspectRatio: string },
  ) {
    const measured = [];
    for (const clip of clips) {
      const p = await probe(clip.file);
      measured.push({ sceneId: clip.sceneId, durationMs: p.durationMs as number });
    }
    const timeline = composeTimeline(measured, 200);
    const input: ComposeGraphInput = {
      format: 'talking_art',
      backgroundArtPath: null,
      window: defaultCharacterWindow({
        width: over.width,
        height: over.height,
        tileWidth: 720,
        tileHeight: 960,
      }),
      logoFace: false,
      backgroundColor: '#112233',
      clips: clips.map((c, i) => ({
        sceneId: c.sceneId,
        path: c.file,
        startS: timeline.clips[i].startS,
        endS: timeline.clips[i].endS,
      })),
      gapMs: 200,
      captionsEnabled: true,
      endcard: null,
      ...over,
    };
    const work = path.join(dir, name);
    await fs.mkdir(work, { recursive: true });
    const plan = buildComposeGraph(input, work);
    await runComposePlan(plan);
    return { input, plan, timeline, out: plan.output };
  }

  /** PSNR da região da arte (janela + faixa de legenda mascaradas) em quadros do trecho falado. */
  async function artPsnr(
    name: string,
    run: Awaited<ReturnType<typeof compose>>,
    times: number[],
  ): Promise<number[]> {
    const { input, plan, out } = run;
    const { width: W, height: H } = input;
    const ref = await referenceLuma(
      input.backgroundArtPath as string,
      buildArtBaseChain(input),
      W,
      H,
    );
    const art = plan.artRect as Rect;
    const caption = captionLayoutFor(
      W,
      H,
      [{ text: 'x'.repeat(38), startS: 0, endS: 1 }],
      plan.windowPx,
    );
    const masks: Rect[] = [
      inset(plan.windowPx, -WINDOW_MARGIN_PX),
      { x: 0, y: caption.band.top, width: W, height: caption.band.bottom - caption.band.top },
    ];
    const values: number[] = [];
    for (const t of times) {
      const frame = await lumaAt(out, t, W, H);
      const { psnr, pixels } = psnrMasked(frame, ref, W, inset(art, ART_EDGE_MARGIN_PX), masks);
      expect(pixels).toBeGreaterThan(art.width * art.height * 0.5);
      values.push(Number(psnr.toFixed(2)));
    }
    measurements[name] = { psnr: values, artRect: art, windowPx: plan.windowPx };
    return values;
  }

  it('arte 1080×1350 (4:5) → 1080×1350: PSNR de luma ≥ 40 dB nos quadros falados, falas nos instantes ±100 ms, janela com o clipe e crossfade; cartela + concat', async () => {
    const art = path.join(dir, 'art-1080x1350.png');
    await syntheticArt(art, 1080, 1350);
    const run = await compose('portrait', {
      width: 1080,
      height: 1350,
      aspectRatio: '4:5',
      backgroundArtPath: art,
      artWidth: 1080,
      artHeight: 1350,
      endcard: { storeName: 'Mercado do Zé' },
    });
    const composed = await probe(run.out);
    expect(composed.width).toBe(1080);
    expect(composed.height).toBe(1350);
    expect(composed.rFrameRate).toBe('30/1');
    expect(
      composedOutputIssue(composed, {
        durationMs: run.plan.expectedDurationMs,
        width: 1080,
        height: 1350,
      }),
    ).toBeNull();
    const psnr = await artPsnr('4:5', run, [0.5, 1.1, 1.8]);
    for (const value of psnr) expect(value).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    // falas: início de cada TTS na timeline (soma das durações + 200 ms), ±100 ms
    const onsets = await speechOnsets(run.out, run.timeline.totalS);
    const expected = run.timeline.clips.map((c) => c.startS);
    expect(onsets).toHaveLength(expected.length);
    onsets.forEach((t, i) => expect(Math.abs(t - expected[i])).toBeLessThanOrEqual(0.1));
    measurements['4:5 onsets'] = { onsets, expected };
    // janela: vermelho na 1ª fala, verde na 2ª, mistura no crossfade (dentro do silêncio)
    const win = inset(run.plan.windowPx, 20);
    const first = await meanRgbAt(run.out, 0.5, win);
    const middle = await meanRgbAt(run.out, run.timeline.clips[0].endS + 0.1, win);
    const second = await meanRgbAt(run.out, 1.9, win);
    expect(first[0]).toBeGreaterThan(200);
    expect(first[1]).toBeLessThan(60);
    expect(second[1]).toBeGreaterThan(200);
    expect(second[0]).toBeLessThan(60);
    expect(middle[0]).toBeGreaterThan(60); // meio do fade: ainda há vermelho
    expect(middle[1]).toBeGreaterThan(60); // ...e já há verde
    // cartela (2 s) depois da última fala
    const endcard = await meanRgbAt(run.out, run.timeline.totalS + 1, {
      x: 0,
      y: 0,
      width: 64,
      height: 64,
    });
    expect(endcard).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(Math.abs(endcard[0] - 0x1f)).toBeLessThanOrEqual(6);
  }, 180_000);

  it('arte 1:1 → 1080×1080 (sem faixas): PSNR ≥ 40 dB', async () => {
    const art = path.join(dir, 'art-1080x1080.png');
    await syntheticArt(art, 1080, 1080);
    const run = await compose('square', {
      width: 1080,
      height: 1080,
      aspectRatio: '1:1',
      backgroundArtPath: art,
      artWidth: 1080,
      artHeight: 1080,
    });
    expect(run.plan.artRect).toEqual({ x: 0, y: 0, width: 1080, height: 1080 });
    const composed = await probe(run.out);
    expect([composed.width, composed.height]).toEqual([1080, 1080]);
    for (const value of await artPsnr('1:1', run, [0.5, 1.8])) {
      expect(value).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    }
  }, 180_000);

  it('arte 1:1 → 9:16 (1080×1920): arte inteira centralizada, faixas na cor acima/abaixo; PSNR ≥ 40 dB só na região da arte', async () => {
    const art = path.join(dir, 'art-sq.png');
    await syntheticArt(art, 1080, 1080);
    const run = await compose('reels', {
      width: 1080,
      height: 1920,
      aspectRatio: '9:16',
      backgroundArtPath: art,
      artWidth: 1080,
      artHeight: 1080,
    });
    expect(run.plan.artRect).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
    const composed = await probe(run.out);
    expect([composed.width, composed.height]).toEqual([1080, 1920]);
    for (const value of await artPsnr('1:1→9:16', run, [0.5, 1.8])) {
      expect(value).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    }
    // faixas de preenchimento = cor (#112233), fora da comparação
    const top = await meanRgbAt(run.out, 0.5, { x: 100, y: 50, width: 200, height: 200 });
    const bottom = await meanRgbAt(run.out, 0.5, { x: 100, y: 1650, width: 200, height: 200 });
    for (const band of [top, bottom]) {
      expect(Math.abs(band[0] - 0x11)).toBeLessThanOrEqual(6);
      expect(Math.abs(band[2] - 0x33)).toBeLessThanOrEqual(6);
    }
  }, 180_000);

  it('arte 1280×928 → 1920×1080: faixas laterais, arte inteira (1490×1080 em x 215); PSNR ≥ 40 dB na região da arte', async () => {
    const art = path.join(dir, 'art-nini.png');
    await syntheticArt(art, 1280, 928);
    const run = await compose('landscape', {
      width: 1920,
      height: 1080,
      aspectRatio: '16:9',
      backgroundArtPath: art,
      artWidth: 1280,
      artHeight: 928,
    });
    expect(run.plan.artRect).toEqual({ x: 215, y: 0, width: 1490, height: 1080 });
    const composed = await probe(run.out);
    expect([composed.width, composed.height]).toEqual([1920, 1080]);
    for (const value of await artPsnr('1280x928→16:9', run, [0.5, 1.8])) {
      expect(value).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    }
  }, 180_000);

  it('rosto do logo: a janela é a caixa do logo (frações da arte) no quadro de saída; o resto da arte intacto', async () => {
    const art = path.join(dir, 'art-logo.png');
    await syntheticArt(art, 1080, 1350);
    const logoBox = { x: 0.62, y: 0.02, w: 0.32, h: 0.1 };
    const run = await compose('logo', {
      width: 1080,
      height: 1920,
      aspectRatio: '9:16',
      backgroundArtPath: art,
      artWidth: 1080,
      artHeight: 1350,
      logoFace: true,
      logoBox,
      backgroundColor: '#C8102E',
    });
    const expectedWindow = artBoxToOutputWindow(logoBox, 1080, 1350, 1080, 1920);
    expect(run.plan.windowPx).toEqual(expectedWindow);
    // clipe ajustado por largura dentro da caixa; excedente vertical na cor
    const center = await meanRgbAt(run.out, 0.5, inset(expectedWindow, 12));
    expect(center[0]).toBeGreaterThan(235); // clipe vermelho (255), não o fundo #C8102E (200)
    expect(center[1]).toBeLessThan(40);
    for (const value of await artPsnr('logo', run, [0.5, 1.8])) {
      expect(value).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    }
  }, 180_000);

  it('preenchimento desfocado: arte inteira nítida no centro (PSNR ≥ 40 dB), faixas com a arte desfocada (não lisas)', async () => {
    const art = path.join(dir, 'art-blur.png');
    await syntheticArt(art, 1080, 1080);
    const run = await compose('blur', {
      width: 1080,
      height: 1920,
      aspectRatio: '9:16',
      backgroundArtPath: art,
      artWidth: 1080,
      artHeight: 1080,
      fill: 'blur',
    });
    for (const value of await artPsnr('blur', run, [0.5])) {
      expect(value).toBeGreaterThanOrEqual(MIN_PSNR_DB);
    }
    const band = await lumaAt(run.out, 0.5, 1080, 1920);
    const sample = [...band.subarray(100 * 1080, 101 * 1080)];
    expect(Math.max(...sample) - Math.min(...sample)).toBeGreaterThan(10);
  }, 180_000);
});
