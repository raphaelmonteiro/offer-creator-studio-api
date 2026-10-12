import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildTalkConformArgs,
  conformedOutputIssue,
  planTalkConform,
} from './mc-talk-conform-graph';

/**
 * Fixtures de MÍDIA com FFmpeg REAL da conformação do clipe falado (change
 * video-formatos-personagem, D7, tarefa 3.5): prova que o grafo produz um
 * arquivo com a duração do ÁUDIO (aparado, clonado ou reprovado), com o
 * aspecto do tile e uma única trilha de voz. Não usa provider nenhum.
 *
 * Roda SOMENTE com `MC_TEST_FFMPEG=1` e binários acessíveis (FFMPEG_PATH /
 * FFPROBE_PATH ou no PATH). Sem isso, os testes ficam marcados como skipped —
 * nunca "passam" por engano (mesmo gate de mc-ffmpeg-render.fixture.spec).
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

/** Clipe sintético de cor com áudio PRÓPRIO (o "áudio do fornecedor", que deve ser descartado). */
async function makeClip(file: string, size: string, durationS: number): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x2E5E9E:s=${size}:r=30:d=${durationS}`,
    '-f',
    'lavfi',
    '-t',
    String(durationS),
    '-i',
    'sine=frequency=880:sample_rate=48000',
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
    file,
  ]);
}

/** "TTS" sintético: tom baixo de 440 Hz com a duração pedida. */
async function makeVoice(file: string, durationS: number): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-af',
    'volume=0.1',
    '-t',
    String(durationS),
    '-codec:a',
    'libmp3lame',
    '-q:a',
    '6',
    file,
  ]);
}

describeIf('conformação do clipe falado — ffmpeg real (MC_TEST_FFMPEG=1)', () => {
  let dir: string;
  let voice: string;
  const AUDIO_MS = 6000;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-talk-conform-'));
    voice = path.join(dir, 'voice.mp3');
    await makeVoice(voice, AUDIO_MS / 1000);
  }, 60_000);

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function conform(
    clip: string,
    tile: { width: number; height: number },
  ): Promise<{ plan: ReturnType<typeof planTalkConform>; out: Probe }> {
    const raw = await probe(clip);
    const audio = await probe(voice);
    const plan = planTalkConform({
      videoMs: raw.durationMs as number,
      audioMs: audio.durationMs as number,
      videoWidth: raw.width,
      videoHeight: raw.height,
      tileWidth: tile.width,
      tileHeight: tile.height,
    });
    const output = path.join(dir, `${path.basename(clip, '.mp4')}-conformed.mp4`);
    await run(
      FFMPEG,
      buildTalkConformArgs({
        videoPath: clip,
        audioPath: voice,
        output,
        plan,
        audioDurationS: (audio.durationMs as number) / 1000,
      }),
    );
    return { plan, out: await probe(output) };
  }

  it('clipe mais LONGO (7,4 s) que o áudio (6 s) → aparado para a duração do áudio', async () => {
    const clip = path.join(dir, 'longer.mp4');
    await makeClip(clip, '720x960', 7.4);
    const { plan, out } = await conform(clip, { width: 720, height: 960 });
    expect(plan.durationAction).toBe('trim');
    expect(out.hasVideo && out.hasAudio).toBe(true);
    expect(out.audioStreams).toBe(1); // áudio do fornecedor descartado, TTS único
    expect(Math.abs((out.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
    expect(conformedOutputIssue(out, AUDIO_MS)).toBeNull();
    expect([out.width, out.height]).toEqual([720, 960]);
  }, 90_000);

  it('clipe 200 ms mais CURTO → último quadro clonado; saída com a duração do áudio', async () => {
    const clip = path.join(dir, 'shorter-200.mp4');
    await makeClip(clip, '720x960', 5.8);
    const { plan, out } = await conform(clip, { width: 720, height: 960 });
    expect(plan.durationAction).toBe('pad');
    expect(Math.abs((out.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
    expect(conformedOutputIssue(out, AUDIO_MS)).toBeNull();
  }, 90_000);

  it('clipe 1,2 s mais curto → too_short (classe quality), nenhum arquivo é gerado', async () => {
    const clip = path.join(dir, 'shorter-1200.mp4');
    await makeClip(clip, '720x960', 4.8);
    const raw = await probe(clip);
    const plan = planTalkConform({
      videoMs: raw.durationMs as number,
      audioMs: AUDIO_MS,
      videoWidth: raw.width,
      videoHeight: raw.height,
      tileWidth: 720,
      tileHeight: 960,
    });
    expect(plan.durationAction).toBe('too_short');
    expect(plan.deltaMs).toBeGreaterThan(300);
  }, 60_000);

  it('tile 3:4 e motor devolve 9:16 → recorte centralizado para 3:4 (720×960), sem barras', async () => {
    const clip = path.join(dir, 'aspect-916.mp4');
    await makeClip(clip, '720x1280', 6);
    const { plan, out } = await conform(clip, { width: 720, height: 960 });
    expect(plan.crop).toEqual({ width: 720, height: 960, x: 0, y: 160 });
    expect([out.width, out.height]).toEqual([720, 960]);
    expect(Math.abs((out.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
  }, 90_000);
});
