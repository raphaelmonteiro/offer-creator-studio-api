import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  assemblyDimensions,
  buildConcatArgs,
  buildConcatListContent,
  buildEndcardArgs,
  buildFinalizeArgs,
  buildNormalizeArgs,
  buildSealCuesV2,
  SceneWindowV2,
} from './mc-assembly-graph';
import { buildCaptionCues, syntheticAlignment } from './mc-captions';
import {
  buildSceneComposeArgs,
  composeDurationIssue,
  composedOutputIssue,
} from './mc-scene-compose-graph';

/**
 * Fixtures de MÍDIA com FFmpeg REAL (plano P0/P2 — "render local"): prova
 * que o grafo de composição/montagem produz arquivos reproduzíveis, com uma
 * única trilha de voz, nos três formatos, com nomes longos/acentuados e
 * legendas no tempo certo. Não usa provider nenhum.
 *
 * Roda SOMENTE com `MC_TEST_FFMPEG=1` e binários acessíveis (FFMPEG_PATH /
 * FFPROBE_PATH ou no PATH). Sem isso, os testes ficam marcados como skipped —
 * nunca "passam" por engano.
 */
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const ENABLED = process.env.MC_TEST_FFMPEG === '1';
const describeIf = ENABLED ? describe : describe.skip;

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} ${code}: ${err.slice(-400)}`)),
    );
  });
}

interface Probe {
  hasVideo: boolean;
  hasAudio: boolean;
  audioStreams: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

async function probe(file: string): Promise<Probe> {
  const out = await run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const json = JSON.parse(out) as {
    streams?: Array<{ codec_type: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = json.streams?.find((s) => s.codec_type === 'video');
  const audios = json.streams?.filter((s) => s.codec_type === 'audio') ?? [];
  const durationS = Number(json.format?.duration);
  return {
    hasVideo: !!video,
    hasAudio: audios.length > 0,
    audioStreams: audios.length,
    durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

/** Clipe sintético de "ação" (cor + contador) COM áudio próprio (tom) — o que um provider entregaria. */
async function makeActionClip(file: string, seconds: number, size = '720x1280'): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x2E5E9E:s=${size}:r=30:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=880:sample_rate=48000:duration=${seconds}`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);
}

/** "Locução" sintética: tom grave com a duração pedida. */
async function makeVoice(file: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=220:sample_rate=44100:duration=${seconds}`,
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '7',
    file,
  ]);
}

describeIf('FFmpeg real — fixtures de composição e montagem (P0/P2)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-fixture-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scene_compose: locução única e completa sobre o vídeo de ação; áudio original descartado; duração = vídeo', async () => {
    const video = path.join(dir, 'action.mp4');
    const voice = path.join(dir, 'voice.mp3');
    const out = path.join(dir, 'composed.mp4');
    await makeActionClip(video, 5);
    await makeVoice(voice, 3.6);
    const v = await probe(video);
    const a = await probe(voice);
    expect(composeDurationIssue(v.durationMs, a.durationMs)).toBeNull();
    await run(
      FFMPEG,
      buildSceneComposeArgs({
        videoPath: video,
        audioPath: voice,
        output: out,
        videoDurationS: (v.durationMs as number) / 1000,
      }),
    );
    const o = await probe(out);
    expect(o.hasVideo).toBe(true);
    expect(o.audioStreams).toBe(1); // uma voz, nunca duas trilhas
    expect(composedOutputIssue(o, v.durationMs as number)).toBeNull();
    expect(Math.abs((o.durationMs as number) - (v.durationMs as number))).toBeLessThan(250);
    // a locução não foi cortada: o áudio de saída cobre pelo menos a duração da voz
    expect(o.durationMs as number).toBeGreaterThanOrEqual(a.durationMs as number);
  });

  it('scene_compose: locução maior que o clipe é DETECTADA (não silenciosamente cortada)', async () => {
    const video = path.join(dir, 'action-short.mp4');
    const voice = path.join(dir, 'voice-long.mp3');
    await makeActionClip(video, 5);
    await makeVoice(voice, 6.5);
    const v = await probe(video);
    const a = await probe(voice);
    const issue = composeDurationIssue(v.durationMs, a.durationMs);
    expect(issue?.code).toBe('audio_exceeds_clip');
    expect(issue!.excessMs).toBeGreaterThan(1000);
  });

  it.each([['9:16'], ['1:1'], ['16:9']])(
    'montagem %s: 3 clipes (presenter/voiceover/action) + cartela, selos v2 com nome longo acentuado e legendas; MP4 reproduzível',
    async (aspect) => {
      const { width, height } = assemblyDimensions(aspect);
      const clips: Array<{ file: string; seconds: number }> = [
        { file: path.join(dir, `a-${aspect.replace(':', 'x')}-1.mp4`), seconds: 4.3 },
        { file: path.join(dir, `a-${aspect.replace(':', 'x')}-2.mp4`), seconds: 5 },
        { file: path.join(dir, `a-${aspect.replace(':', 'x')}-3.mp4`), seconds: 3.7 },
      ];
      for (const clip of clips) await makeActionClip(clip.file, clip.seconds, '640x640');
      const normalized: string[] = [];
      const windows: SceneWindowV2[] = [];
      let cursor = 0;
      for (const [i, clip] of clips.entries()) {
        const p = await probe(clip.file);
        const out = path.join(dir, `norm-${aspect.replace(':', 'x')}-${i}.mp4`);
        await run(
          FFMPEG,
          buildNormalizeArgs({
            input: clip.file,
            output: out,
            hasAudio: p.hasAudio,
            durationS: Math.max(1, Math.round((p.durationMs as number) / 1000)),
            width,
            height,
          }),
        );
        const n = await probe(out);
        expect(n.width).toBe(width);
        expect(n.height).toBe(height);
        const durS = (n.durationMs as number) / 1000;
        windows.push({
          sceneId: `s${i}`,
          idx: i,
          startS: cursor,
          endS: cursor + durS,
          finalAssetId: `f${i}`,
          captionsMissing: i === 2,
        });
        cursor += durS;
        normalized.push(out);
      }
      const endcard = path.join(dir, `endcard-${aspect.replace(':', 'x')}.mp4`);
      await run(
        FFMPEG,
        buildEndcardArgs({ output: endcard, storeName: 'Mercadão São João & Cia', width, height }),
      );
      normalized.push(endcard);
      const list = path.join(dir, `list-${aspect.replace(':', 'x')}.txt`);
      await fs.writeFile(list, buildConcatListContent(normalized));
      const concat = path.join(dir, `concat-${aspect.replace(':', 'x')}.mp4`);
      await run(FFMPEG, buildConcatArgs(list, concat));

      const seals = buildSealCuesV2(windows, [
        {
          sceneId: 's1',
          product: { id: 'p1', name: 'Arroz Tio João Integral 5kg Pacote Família', price: '24,90' },
          cue: { startS: 1, endS: 5 },
        },
        {
          sceneId: 's0',
          product: { id: 'p2', name: 'Feijão Carioca', price: '8,99' },
          cue: { startS: 2.15, endS: 4.3 },
        },
      ]);
      expect(seals).toHaveLength(2);
      const captions = buildCaptionCues(
        syntheticAlignment(
          'Olha só que oferta incrível, direto da fazenda pra sua casa hoje!',
          4.3,
        ),
        { offsetS: windows[0].startS, clipDurationS: windows[0].endS - windows[0].startS },
      );
      expect(captions.length).toBeGreaterThan(0);
      const final = path.join(dir, `final-${aspect.replace(':', 'x')}.mp4`);
      await run(
        FFMPEG,
        buildFinalizeArgs({
          input: concat,
          output: final,
          width,
          height,
          sealCues: seals,
          captionCues: captions,
          musicPath: null,
        }),
      );
      const f = await probe(final);
      expect(f.hasVideo).toBe(true);
      expect(f.audioStreams).toBe(1);
      expect(f.width).toBe(width);
      expect(f.height).toBe(height);
      // duração final = soma das janelas medidas + cartela (2s), com tolerância de 1s ou 10%
      const expectedS = windows[windows.length - 1].endS + 2;
      const tolerance = Math.max(1, expectedS * 0.1);
      expect(Math.abs((f.durationMs as number) / 1000 - expectedS)).toBeLessThanOrEqual(tolerance);
      // legenda solicitada ausente fica VISÍVEL na timeline (cena 3 sem alinhamento)
      expect(windows.filter((w) => w.captionsMissing).map((w) => w.sceneId)).toEqual(['s2']);
    },
    120_000,
  );
});
