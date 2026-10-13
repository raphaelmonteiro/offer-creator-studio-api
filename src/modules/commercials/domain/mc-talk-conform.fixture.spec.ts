import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildTalkConformArgs,
  conformedOutputIssue,
  planTalkConform,
} from './mc-talk-conform-graph';
import { MINIMAX_H3_LIPSYNC_MODEL } from './mc-pipeline.config';
import {
  buildTalkAudioPadArgs,
  planTalkAudioPadding,
  talkBilledDurationMs,
} from './mc-talk-engines';

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
  /** Duração do CONTAINER (`format.duration`): com `apad` + `-t`, é sempre a do áudio. */
  durationMs: number | null;
  /**
   * Duração e quadros da TRILHA DE VÍDEO (`v:0`): é aqui que o clone do último
   * quadro aparece — sem `tpad`, o container ainda mede o áudio, mas o vídeo
   * fica mais curto.
   */
  videoDurationMs: number | null;
  videoFrames: number | null;
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
    streams?: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      duration?: string;
      nb_frames?: string;
    }>;
    format?: { duration?: string };
  };
  const video = json.streams?.find((s) => s.codec_type === 'video');
  const audios = json.streams?.filter((s) => s.codec_type === 'audio') ?? [];
  const durationS = Number(json.format?.duration);
  const videoS = Number(video?.duration);
  const frames = Number(video?.nb_frames);
  return {
    hasVideo: !!video,
    hasAudio: audios.length > 0,
    audioStreams: audios.length,
    durationMs: Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
    videoDurationMs: Number.isFinite(videoS) ? Math.round(videoS * 1000) : null,
    videoFrames: Number.isFinite(frames) ? frames : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

/** Codec, taxa e canais da primeira trilha de áudio. */
async function audioStreamInfo(
  file: string,
): Promise<{ codec: string | null; sampleRate: number | null; channels: number | null }> {
  const out = await run(FFPROBE, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    file,
  ]);
  const stream = (
    JSON.parse(out) as {
      streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
    }
  ).streams?.[0];
  return {
    codec: stream?.codec_name ?? null,
    sampleRate: stream?.sample_rate ? Number(stream.sample_rate) : null,
    channels: stream?.channels ?? null,
  };
}

/** PCM mono s16le a 8 kHz da primeira trilha de áudio no trecho [startS, startS + durS). */
function decodePcm(file: string, startS: number, durS: number): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        '-v',
        'error',
        '-ss',
        startS.toFixed(3),
        '-t',
        durS.toFixed(3),
        '-i',
        file,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg pcm ${code}: ${err.slice(-400)}`));
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

/**
 * Duração DECODIFICADA (ms) da primeira trilha de áudio: amostras PCM na taxa
 * nativa ÷ taxa — o que um decodificador que respeita o cabeçalho Info/LAME
 * (ffmpeg, pydub, librosa) entrega, sem o atraso do encoder que o
 * `format.duration` do ffprobe soma num MP3.
 */
async function decodedDurationMs(file: string): Promise<number> {
  const { sampleRate } = await audioStreamInfo(file);
  const bytes = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 's16le', '-'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let total = 0;
    let err = '';
    child.stdout.on('data', (d: Buffer) => (total += d.length));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(total) : reject(new Error(`ffmpeg decode ${code}: ${err.slice(-400)}`)),
    );
  });
  return (bytes / 2 / (sampleRate as number)) * 1000;
}

/** MP3 CBR 128 kbps mono 44,1 kHz (cabeçalho Info/LAME, como o TTS da ElevenLabs) com `durationS` de tom. */
async function makeCbrVoice(file: string, durationS: number): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${durationS}`,
    '-af',
    'volume=0.1',
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    file,
  ]);
}

function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return Math.sqrt(sum / pcm.length);
}

/** Frequência dominante (Hz) de um tom puro por cruzamentos de zero (PCM a 8 kHz). */
function toneHz(pcm: Int16Array, sampleRate = 8000): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length; i += 1) {
    if ((pcm[i - 1] < 0 && pcm[i] >= 0) || (pcm[i - 1] >= 0 && pcm[i] < 0)) crossings += 1;
  }
  return crossings / 2 / (pcm.length / sampleRate);
}

/** Trilha de VÍDEO cobre o áudio inteiro: duração ±120 ms e quadros a 30 fps (±1). */
function expectVideoTrackCoversAudio(out: Probe, audioMs: number): void {
  expect(out.videoDurationMs).not.toBeNull();
  expect(Math.abs((out.videoDurationMs as number) - audioMs)).toBeLessThanOrEqual(120);
  expect(out.videoFrames).not.toBeNull();
  expect(
    Math.abs((out.videoFrames as number) - Math.round((audioMs / 1000) * 30)),
  ).toBeLessThanOrEqual(1);
}

/**
 * Clipe sintético de cor com áudio PRÓPRIO (o "áudio do fornecedor", que deve
 * ser descartado). `odd` simula um motor que devolve dimensões ÍMPARES: a
 * fonte lavfi `color` arredonda para par, então o tamanho ímpar entra por
 * `scale` depois dela, em 4:4:4 (o 4:2:0 exige dimensões pares).
 */
async function makeClip(file: string, size: string, durationS: number, odd = false): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x2E5E9E:s=${odd ? '720x960' : size}:r=30:d=${durationS}`,
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
    ...(odd ? ['-vf', `scale=${size.replace('x', ':')}`] : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    odd ? 'yuv444p' : 'yuv420p',
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

  function conformedPath(clip: string): string {
    return path.join(dir, `${path.basename(clip, '.mp4')}-conformed.mp4`);
  }

  /** `padMaxMs` opcional = o replanejamento do ingest no teto esgotado (H1: clone ilimitado). */
  async function conform(
    clip: string,
    tile: { width: number; height: number },
    padMaxMs?: number,
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
      ...(padMaxMs === undefined ? {} : { padMaxMs }),
    });
    const output = conformedPath(clip);
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
    expectVideoTrackCoversAudio(out, AUDIO_MS);
    expect(conformedOutputIssue(out, AUDIO_MS)).toBeNull();
    expect([out.width, out.height]).toEqual([720, 960]);
  }, 90_000);

  it('clipe 200 ms mais CURTO → último quadro clonado; saída com a duração do áudio', async () => {
    const clip = path.join(dir, 'shorter-200.mp4');
    await makeClip(clip, '720x960', 5.8);
    const { plan, out } = await conform(clip, { width: 720, height: 960 });
    expect(plan.durationAction).toBe('pad');
    expect(Math.abs((out.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
    // o clone aparece na TRILHA DE VÍDEO (180 quadros a 30 fps), não só no container
    expectVideoTrackCoversAudio(out, AUDIO_MS);
    expect(conformedOutputIssue(out, AUDIO_MS)).toBeNull();

    // controle: o mesmo comando SEM o clone (`tpad`) engana o container (`apad` +
    // `-t` o deixam com a duração do áudio), mas a trilha de vídeo fica em ~5,8 s
    const audio = await probe(voice);
    const unpadded = path.join(dir, 'shorter-200-unpadded.mp4');
    await run(
      FFMPEG,
      buildTalkConformArgs({
        videoPath: clip,
        audioPath: voice,
        output: unpadded,
        plan: { ...plan, durationAction: 'keep', padS: 0 },
        audioDurationS: (audio.durationMs as number) / 1000,
      }),
    );
    const control = await probe(unpadded);
    expect(Math.abs((control.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
    expect(control.videoFrames as number).toBeLessThan(Math.round((AUDIO_MS / 1000) * 30) - 3);
  }, 90_000);

  it('clipe 1,2 s mais curto → too_short (classe quality): nenhum comando nem arquivo; no teto esgotado (H1) o último quadro é clonado até o áudio', async () => {
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
    // reprovação: o grafo se recusa a montar o comando e nada é gravado
    const output = conformedPath(clip);
    expect(() =>
      buildTalkConformArgs({
        videoPath: clip,
        audioPath: voice,
        output,
        plan,
        audioDurationS: AUDIO_MS / 1000,
      }),
    ).toThrow(/too_short/);
    await expect(fs.access(output)).rejects.toThrow();

    // teto da classe `quality` esgotado: o ingest replaneja com clone
    // ilimitado e o arquivo sai com a duração do ÁUDIO (1,2 s de último quadro)
    const accepted = await conform(clip, { width: 720, height: 960 }, Infinity);
    expect(accepted.plan.durationAction).toBe('pad');
    expect(accepted.plan.deltaMs).toBeGreaterThan(300);
    expect(accepted.out.hasVideo && accepted.out.hasAudio).toBe(true);
    expect(accepted.out.audioStreams).toBe(1);
    expect(Math.abs((accepted.out.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
    expectVideoTrackCoversAudio(accepted.out, AUDIO_MS);
    expect(conformedOutputIssue(accepted.out, AUDIO_MS)).toBeNull();
    expect([accepted.out.width, accepted.out.height]).toEqual([720, 960]);
  }, 120_000);

  it('motor devolve dimensões ÍMPARES (721×961) sem desvio de aspecto → saída par 720×960 (L1)', async () => {
    const clip = path.join(dir, 'odd-dims.mp4');
    await makeClip(clip, '721x961', 6, true);
    const raw = await probe(clip);
    expect([raw.width, raw.height]).toEqual([721, 961]);
    const { plan, out } = await conform(clip, { width: 720, height: 960 });
    expect(plan.crop).toBeNull();
    expect(plan.forceEvenDims).toBe(true);
    expect([out.width, out.height]).toEqual([720, 960]);
    expect(Math.abs((out.durationMs as number) - AUDIO_MS)).toBeLessThanOrEqual(120);
    expect(conformedOutputIssue(out, AUDIO_MS)).toBeNull();
  }, 90_000);

  it('fala curta no motor do logo (H3, decisão de 13/10/2026): TTS de 2 s completado com silêncio até 5,15 s (mínimo + folga; MP3, mesma taxa); o clipe do fornecedor é aparado a 2 s com o TTS ORIGINAL', async () => {
    // TTS curto (tom de 440 Hz) — o asset original, que nunca é alterado
    const shortVoice = path.join(dir, 'short-voice.mp3');
    await makeVoice(shortVoice, 2);
    const original = await probe(shortVoice);
    const speechMs = original.durationMs as number;
    const originalBytes = await fs.readFile(shortVoice);

    // 1) submit: silêncio no fim até o mínimo do H3 + 150 ms de folga da medida do MP3
    const plan = planTalkAudioPadding(MINIMAX_H3_LIPSYNC_MODEL, speechMs);
    expect(plan).toMatchObject({ minS: 5, submittedMs: 5150 });
    const padded = path.join(dir, 'short-voice-padded.mp3');
    await run(
      FFMPEG,
      buildTalkAudioPadArgs({
        input: shortVoice,
        output: padded,
        totalS: (plan as NonNullable<typeof plan>).submittedMs / 1000,
      }),
    );
    const paddedProbe = await probe(padded);
    // contêiner ≥ alvo e no máximo um par de quadros MP3 acima; DECODIFICADO ≥ 5,15 s
    // (folga real sobre o mínimo de 5 s, qualquer que seja a medida do fornecedor)
    expect(paddedProbe.durationMs as number).toBeGreaterThanOrEqual(5150);
    expect(paddedProbe.durationMs as number).toBeLessThanOrEqual(5250);
    expect(await decodedDurationMs(padded)).toBeGreaterThanOrEqual(5149);
    expect(paddedProbe.hasVideo).toBe(false);
    // mesmo codec (MP3 → data URI audio/mpeg), mesma taxa de amostragem e canais do TTS
    const originalInfo = await audioStreamInfo(shortVoice);
    expect(await audioStreamInfo(padded)).toEqual({ ...originalInfo, codec: 'mp3' });
    // fala no começo, silêncio no fim
    expect(rms(await decodePcm(padded, 0.2, 1.6))).toBeGreaterThan(100); // tom ~ 270 RMS
    expect(rms(await decodePcm(padded, 2.3, 2.5))).toBeLessThan(5);
    // o TTS original fica intacto
    expect((await fs.readFile(shortVoice)).equals(originalBytes)).toBe(true);

    // 2) o fornecedor devolve um clipe com a duração ENVIADA e o PRÓPRIO áudio (tom de 880 Hz)
    const clip = path.join(dir, 'h3-padded.mp4');
    await makeClip(clip, '720x960', (paddedProbe.durationMs as number) / 1000);
    const raw = await probe(clip);
    expect(
      Math.abs((raw.durationMs as number) - (paddedProbe.durationMs as number)),
    ).toBeLessThanOrEqual(120);

    // 3) ingest: conformação contra o TTS ORIGINAL (2 s), nunca contra o áudio enviado
    const conformPlan = planTalkConform({
      videoMs: raw.durationMs as number,
      audioMs: speechMs,
      videoWidth: raw.width,
      videoHeight: raw.height,
      tileWidth: 720,
      tileHeight: 960,
    });
    expect(conformPlan.durationAction).toBe('trim');
    expect(conformPlan.deltaMs).toBeLessThan(-2900);
    const output = conformedPath(clip);
    await run(
      FFMPEG,
      buildTalkConformArgs({
        videoPath: clip,
        audioPath: shortVoice,
        output,
        plan: conformPlan,
        audioDurationS: speechMs / 1000,
      }),
    );
    const out = await probe(output);
    expect(out.hasVideo && out.hasAudio).toBe(true);
    expect(out.audioStreams).toBe(1);
    expect(Math.abs((out.durationMs as number) - speechMs)).toBeLessThanOrEqual(120);
    expectVideoTrackCoversAudio(out, speechMs);
    expect(conformedOutputIssue(out, speechMs)).toBeNull();
    expect([out.width, out.height]).toEqual([720, 960]);
    // a trilha é o TTS original (440 Hz), não o áudio do fornecedor (880 Hz)
    const hz = toneHz(await decodePcm(output, 0.3, 1.4));
    expect(Math.abs(hz - 440)).toBeLessThanOrEqual(30);

    // 4) custo: os segundos ENVIADOS (o clipe entregue tem 2 s)
    expect(talkBilledDurationMs(raw.durationMs, plan)).toBeGreaterThanOrEqual(5150);
  }, 120_000);

  it('fala de 4,97 s DECODIFICADOS que o ffprobe mede ≥ 5 s (atraso do encoder MP3) → completada pelo plano; o áudio enviado decodifica ≥ 5,15 s (nunca abaixo do mínimo do H3)', async () => {
    const voice497 = path.join(dir, 'voice-4970.mp3');
    await makeCbrVoice(voice497, 4.97);
    const decoded = await decodedDurationMs(voice497);
    const probed = (await probe(voice497)).durationMs as number;
    // o problema: o contêiner passa do mínimo, o áudio real não
    expect(decoded).toBeGreaterThan(4960);
    expect(decoded).toBeLessThan(5000);
    expect(probed).toBeGreaterThanOrEqual(5000);

    // o plano usa a medida do asset (a do probe) e completa mesmo assim
    const plan = planTalkAudioPadding(MINIMAX_H3_LIPSYNC_MODEL, probed);
    expect(plan).toMatchObject({ minS: 5, speechMs: probed, submittedMs: 5150 });
    const padded = path.join(dir, 'voice-4970-padded.mp3');
    await run(
      FFMPEG,
      buildTalkAudioPadArgs({
        input: voice497,
        output: padded,
        totalS: (plan as NonNullable<typeof plan>).submittedMs / 1000,
      }),
    );
    expect(await decodedDurationMs(padded)).toBeGreaterThanOrEqual(5149);
    expect((await probe(padded)).durationMs as number).toBeGreaterThanOrEqual(5150);
    // a fala inteira continua lá (tom até ~4,9 s), silêncio só depois dela
    expect(rms(await decodePcm(padded, 4.7, 0.2))).toBeGreaterThan(100);
    expect(rms(await decodePcm(padded, 5.02, 0.1))).toBeLessThan(5);
  }, 120_000);

  it('fala que alcança o alvo (≥ 5,15 s no probe) vai sem silêncio e decodifica acima do mínimo de 5 s', async () => {
    const voice = path.join(dir, 'voice-5200.mp3');
    await makeCbrVoice(voice, 5.2);
    const probed = (await probe(voice)).durationMs as number;
    expect(probed).toBeGreaterThanOrEqual(5150);
    expect(planTalkAudioPadding(MINIMAX_H3_LIPSYNC_MODEL, probed)).toBeNull();
    expect(await decodedDurationMs(voice)).toBeGreaterThan(5000);
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
