import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  ffmpeg,
  FFMPEG_FIXTURES_ENABLED,
  inset,
  keyframeIndexes,
  lumaAt,
  meanLoudness,
  momentaryLoudness,
  mp4TopLevelAtoms,
  probe,
  psnrMasked,
  Rect,
  referenceLuma,
  runComposePlan,
  syntheticArt,
  tinyClip,
} from './__fixtures__/mc-ffmpeg-fixture.helpers';
import {
  buildFinalizeGraph,
  FinalizeGraphInput,
  FinalizeGraphPlan,
  LoudnessMeasurement,
  MC_FINALIZE_LOUDNESS,
  parseEbur128Metadata,
  resolveLoudnormPlan,
} from './mc-finalize-graph';
import {
  buildArtBaseChain,
  buildComposeGraph,
  ComposeGraphInput,
  ComposeGraphPlan,
  composeTimeline,
} from './mc-talking-art-graph';
import { defaultCharacterWindow } from './mc-talking-art-window';

/**
 * Fixture com FFmpeg REAL do finalize do F1 (tarefa 4.5, specs "Mix de
 * áudio", "Perfil de encode por canal", "Legendas por formato" e "Fidelidade
 * da arte" no vídeo FINAL): arte sintética 4:5 composta em 9:16 com duas
 * falas (a primeira com pausa de 1,2 s), trilha de nível constante (tom de
 * 2,5 kHz, isolado por passa-banda na medição) → passe 1 (medição), passe 2
 * (render) e passe 3 (medição da entrega), como o processor. Roda SOMENTE com
 * `MC_TEST_FFMPEG=1`; sem isso fica skipped.
 */
const describeIf = FFMPEG_FIXTURES_ENABLED ? describe : describe.skip;

/** Passa-banda estreito (duas vezes) em 2,5 kHz: isola a trilha da fala (300 Hz). */
const MUSIC_ONLY = 'bandpass=f=2500:width_type=q:w=8,bandpass=f=2500:width_type=q:w=8';

async function readMeasurement(file: string): Promise<LoudnessMeasurement | null> {
  return parseEbur128Metadata(await fs.readFile(file, 'utf8').catch(() => ''));
}

/** Executa o plano como o McFinalizeProcessor: mede (com re-medição), renderiza, mede a entrega. */
async function runFinalize(plan: FinalizeGraphPlan) {
  const resolved = await resolveLoudnormPlan(
    plan.measure,
    async (pass) => {
      await ffmpeg(pass.args);
      return readMeasurement(pass.metadataPath);
    },
    MC_FINALIZE_LOUDNESS,
  );
  const render = plan.render(resolved.loudnorm);
  await ffmpeg(render.args);
  await ffmpeg(plan.verify.args);
  const delivered = await readMeasurement(plan.verify.metadataPath);
  return { resolved, render, delivered };
}

describeIf(
  'finalize com ffmpeg real — legendas, ducking, loudnorm 2 passes e perfis (MC_TEST_FFMPEG=1)',
  () => {
    let dir: string;
    let artPath: string;
    let musicPath: string;
    let composeInput: ComposeGraphInput;
    let composePlan: ComposeGraphPlan;
    /** Janelas de fala (o que o processor deriva dos timestamps): pausa de 1,2 s na 1ª fala. */
    let speechWindows: FinalizeGraphInput['speechWindows'];
    const measurements: Record<string, unknown> = {};

    const finalizeInput = (over: Partial<FinalizeGraphInput>): FinalizeGraphInput => ({
      sourcePath: composePlan.output,
      output: path.join(dir, 'final.mp4'),
      channel: 'instagram',
      width: 1080,
      height: 1920,
      musicPath,
      speechWindows,
      captionCues: [
        { text: 'Olá! Chegaram as ofertas', startS: 0.3, endS: 1.0 },
        { text: 'Feijão carioca — R$ 8,99!', startS: 2.2, endS: 3.0 },
        { text: 'Corre pro Mercado do Zé', startS: 3.2, endS: 5.2 },
      ],
      windowPx: composePlan.windowPx,
      loudness: { ...MC_FINALIZE_LOUDNESS },
      durationMs: composePlan.expectedDurationMs,
      ...over,
    });

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-f1-finalize-'));
      artPath = path.join(dir, 'art.png');
      await syntheticArt(artPath, 1080, 1350);
      // fala 1 (3 s): tom em 0,3–1,0 s e 2,2–3,0 s (pausa de 1,2 s); fala 2 (2 s): tom contínuo
      const a = path.join(dir, 'a.mp4');
      const b = path.join(dir, 'b.mp4');
      await tinyClip(a, 3, 'red', {
        audio:
          "sine=frequency=300:sample_rate=48000,volume='0.5*(between(t,0.3,1.0)+between(t,2.2,3.0))':eval=frame",
      });
      await tinyClip(b, 2, 'lime', { audio: 'sine=frequency=300:sample_rate=48000,volume=0.5' });
      const timeline = composeTimeline(
        [
          { sceneId: 'a', durationMs: (await probe(a)).durationMs as number },
          { sceneId: 'b', durationMs: (await probe(b)).durationMs as number },
        ],
        200,
      );
      composeInput = {
        format: 'talking_art',
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        backgroundArtPath: artPath,
        artWidth: 1080,
        artHeight: 1350,
        window: defaultCharacterWindow({
          width: 1080,
          height: 1920,
          tileWidth: 720,
          tileHeight: 960,
        }),
        logoFace: false,
        backgroundColor: '#112233',
        clips: [
          { sceneId: 'a', path: a, ...timeline.clips[0] },
          { sceneId: 'b', path: b, ...timeline.clips[1] },
        ],
        gapMs: 200,
        captionsEnabled: true,
        endcard: { storeName: 'Mercado do Zé' }, // 2 s finais só com trilha: o nível base
      };
      composePlan = buildComposeGraph(composeInput, dir);
      await runComposePlan(composePlan);
      speechWindows = [
        { sceneId: 'a', startS: 0.3, endS: 1.0 },
        { sceneId: 'a', startS: 2.2, endS: 3.0 },
        { sceneId: 'b', startS: timeline.clips[1].startS, endS: timeline.clips[1].endS },
      ];
      musicPath = path.join(dir, 'music.mp3');
      await ffmpeg([
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-t',
        '15',
        '-i',
        'sine=frequency=2500:sample_rate=44100',
        '-af',
        'volume=0.5',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        musicPath,
      ]);
    }, 120_000);

    afterAll(async () => {
      // eslint-disable-next-line no-console
      console.log(`[F1 finalize fixture] ${JSON.stringify(measurements)}`);
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('Instagram: trilha ≥ 12 LU abaixo dentro das falas e de volta a 1 LU na pausa de 1,2 s; −15..−13 LUFS e ≤ −1 dBTP; High 30 fps CFR, GOP 30, moov antes de mdat; legendas queimadas; PSNR da arte ≥ 40 dB no vídeo final', async () => {
      const plan = buildFinalizeGraph(finalizeInput({ output: path.join(dir, 'final-ig.mp4') }));
      const { resolved, render, delivered } = await runFinalize(plan);
      expect(resolved.loudnorm.mode).not.toBe('dynamic');

      // ── ducking medido na entrega: só a trilha (passa-banda em 2,5 kHz) ──
      const series = await momentaryLoudness(plan.output, MUSIC_ONLY);
      const base = meanLoudness(series, 6.0, 7.1); // cartela: só trilha, longe das falas
      const ducked1 = meanLoudness(series, 0.75, 1.0); // janela de 400 ms inteira em 0,3–1,0
      const ducked2 = meanLoudness(series, 2.65, 5.15); // 2,2–3,0 + 3,2–5,2 (fundidas)
      const pause = meanLoudness(series, 1.7, 2.05); // pausa: 1,0 + 0,25 (liberação) … 2,2 − 0,12 (ataque)
      measurements.ducking = {
        base: Number(base.toFixed(2)),
        ducked1: Number(ducked1.toFixed(2)),
        ducked2: Number(ducked2.toFixed(2)),
        pause: Number(pause.toFixed(2)),
        diff1: Number((base - ducked1).toFixed(2)),
        diff2: Number((base - ducked2).toFixed(2)),
        pauseRecovery: Number((base - pause).toFixed(2)),
      };
      expect(base - ducked1).toBeGreaterThanOrEqual(12);
      expect(base - ducked2).toBeGreaterThanOrEqual(12);
      expect(Math.abs(base - pause)).toBeLessThanOrEqual(1);

      // ── loudness da entrega ──
      expect(delivered).not.toBeNull();
      measurements.instagram = {
        pass1: resolved.pass1,
        loudnorm: resolved.loudnorm.mode,
        delivered,
      };
      expect(delivered!.I).toBeGreaterThanOrEqual(-15);
      expect(delivered!.I).toBeLessThanOrEqual(-13);
      expect(delivered!.TP).toBeLessThanOrEqual(-1);

      // ── perfil: ffprobe + átomos + GOP ──
      const final = await probe(plan.output);
      expect(final.profile).toBe('High');
      expect(final.level).toBe(41);
      expect(final.rFrameRate).toBe('30/1');
      expect(final.avgFrameRate).toBe('30/1');
      expect(final.audioCodec).toBe('aac');
      expect(final.audioRate).toBe(48000);
      expect([final.width, final.height]).toEqual([1080, 1920]);
      expect(
        Math.abs((final.durationMs as number) - composePlan.expectedDurationMs),
      ).toBeLessThanOrEqual(150);
      const atoms = await mp4TopLevelAtoms(plan.output);
      expect(atoms.indexOf('moov')).toBeGreaterThanOrEqual(0);
      expect(atoms.indexOf('moov')).toBeLessThan(atoms.indexOf('mdat'));
      const keys = await keyframeIndexes(plan.output);
      expect(keys.slice(0, 4)).toEqual([0, 30, 60, 90]);
      expect(render.profile.channel).toBe('instagram');

      // ── legendas queimadas na faixa (dentro da área segura) ──
      const band = plan.captions.layout!.band;
      const bandRect: Rect = {
        x: band.left,
        y: band.top,
        width: band.right - band.left,
        height: band.bottom - band.top,
      };
      const withCaption = await lumaAt(plan.output, 2.6, 1080, 1920);
      const withoutCaption = await lumaAt(plan.output, 1.5, 1080, 1920);
      const diff = psnrMasked(withCaption, withoutCaption, 1080, bandRect, []);
      expect(diff.psnr).toBeLessThan(30); // a linha mudou a faixa

      // ── fidelidade da arte no vídeo FINAL (janela + faixa mascaradas) ──
      const ref = await referenceLuma(artPath, buildArtBaseChain(composeInput), 1080, 1920);
      const art = composePlan.artRect as Rect;
      const masks: Rect[] = [
        inset(composePlan.windowPx, -8),
        { x: 0, y: band.top - 4, width: 1080, height: band.bottom - band.top + 8 },
      ];
      const psnr: number[] = [];
      for (const t of [0.6, 2.6, 4.0]) {
        const frame = await lumaAt(plan.output, t, 1080, 1920);
        psnr.push(Number(psnrMasked(frame, ref, 1080, inset(art, 2), masks).psnr.toFixed(2)));
      }
      measurements.finalPsnr = psnr;
      for (const value of psnr) expect(value).toBeGreaterThanOrEqual(40);
    }, 240_000);

    it('WhatsApp: Main sem B-frames, ≤ 16 MB, AAC 48 kHz, moov antes de mdat, loudness no alvo', async () => {
      const plan = buildFinalizeGraph(
        finalizeInput({ channel: 'whatsapp', output: path.join(dir, 'final-wa.mp4') }),
      );
      const { delivered, render } = await runFinalize(plan);
      const final = await probe(plan.output);
      measurements.whatsapp = {
        delivered,
        sizeBytes: final.sizeBytes,
        kbps: render.profile.videoBitrateKbps,
      };
      expect(final.profile).toBe('Main');
      expect(final.hasBFrames).toBe(0);
      expect(final.level).toBe(40);
      expect(final.audioCodec).toBe('aac');
      expect(final.audioRate).toBe(48000);
      expect(final.sizeBytes as number).toBeLessThanOrEqual(16_000_000);
      expect(final.rFrameRate).toBe('30/1');
      const atoms = await mp4TopLevelAtoms(plan.output);
      expect(atoms.indexOf('moov')).toBeLessThan(atoms.indexOf('mdat'));
      expect(delivered!.I).toBeGreaterThanOrEqual(-15);
      expect(delivered!.I).toBeLessThanOrEqual(-13);
      expect(delivered!.TP).toBeLessThanOrEqual(-1);
    }, 240_000);

    it('fala com picos (crista alta): re-mede com limitador, loudnorm segue linear e a entrega fica em −15..−13 LUFS e ≤ −1 dBTP', async () => {
      // fala com cliques fortes sobre tom baixo: o pico previsto passa do teto
      const spiky = path.join(dir, 'spiky.mp4');
      await tinyClip(spiky, 6, 'blue', {
        audio:
          "aevalsrc='0.05*sin(2*PI*300*t)+0.9*lt(mod(t,0.25),0.002)*sin(2*PI*2000*t)':s=48000:c=stereo",
      });
      const composed = buildComposeGraph(
        {
          ...composeInput,
          endcard: null,
          clips: [{ sceneId: 's', path: spiky, startS: 0, endS: 6 }],
        },
        path.join(dir, 'spiky-work'),
      );
      await fs.mkdir(path.join(dir, 'spiky-work'), { recursive: true });
      await runComposePlan(composed);
      const plan = buildFinalizeGraph(
        finalizeInput({
          sourcePath: composed.output,
          output: path.join(dir, 'spiky-work', 'final.mp4'),
          musicPath: null,
          speechWindows: [{ sceneId: 's', startS: 0, endS: 6 }],
          captionCues: [],
          durationMs: composed.expectedDurationMs,
        }),
      );
      const { resolved, delivered } = await runFinalize(plan);
      measurements.limited = {
        measurements: resolved.measurements,
        limiterDb: resolved.loudnorm.limiterDb,
        delivered,
      };
      expect(resolved.loudnorm.mode).toBe('linear_limited');
      expect(resolved.measurements.length).toBeGreaterThan(1);
      expect(delivered!.I).toBeGreaterThanOrEqual(-15);
      expect(delivered!.I).toBeLessThanOrEqual(-13);
      expect(delivered!.TP).toBeLessThanOrEqual(-1);
    }, 240_000);
  },
);
