import {
  MC_TALK_CONFORM_FPS,
  TalkConformPlan,
  MC_TALK_EVEN_DIMS_FILTER,
} from './mc-talk-conform-graph';
import { ChunkSplicePlan } from './mc-talk-chunks';
import { ChunkSnapshot } from './mc-talk-chunk-step';

/**
 * Argumentos de ffmpeg do trecho de fala contínua (change video-fala-continua, D5/D7/D8) — funções
 * PURAS; o processor executa via FfmpegRunner.
 */

const sec = (ms: number) => (ms / 1000).toFixed(3);
const SAMPLE_RATE = 44100;

export type ChunkAudioFormat = 'mp3' | 'wav';

/**
 * Emenda do áudio do trecho (D5): cada TTS normalizado (mono, 44,1 kHz) e ajustado à duração MEDIDA da
 * fala (`atrim` + `apad`), silêncios exatos entre falas, cauda e enchimento único do motor; saída
 * MP3 CBR 128 kbps (o que vai ao motor) ou WAV sem perdas (a trilha das fatias). Sem `atempo`.
 */
export function buildChunkSpliceArgs(opts: {
  /** Arquivos dos TTS, alinhados às FALAS do plano (ordem dos segmentos `speech`). */
  inputs: string[];
  plan: ChunkSplicePlan;
  output: string;
  format: ChunkAudioFormat;
  /** Sem o enchimento do motor (a trilha das fatias é só a timeline do trecho). */
  withPad: boolean;
}): string[] {
  const segments = opts.withPad
    ? opts.plan.segments
    : opts.plan.segments.filter((s) => !(s.kind === 'silence' && s.reason === 'pad'));
  const total = segments.reduce((sum, s) => sum + s.durationMs, 0);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of opts.inputs) args.push('-i', input);
  const graph: string[] = [];
  let speechIndex = 0;
  const labels = segments.map((segment, i) => {
    const label = `s${i}`;
    const dur = sec(segment.durationMs);
    if (segment.kind === 'speech') {
      graph.push(
        `[${speechIndex}:a]aformat=sample_rates=${SAMPLE_RATE}:channel_layouts=mono,` +
          `atrim=0:${dur},asetpts=PTS-STARTPTS,apad=whole_dur=${dur}[${label}]`,
      );
      speechIndex += 1;
    } else {
      graph.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=0:${dur},asetpts=PTS-STARTPTS[${label}]`);
    }
    return `[${label}]`;
  });
  graph.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`);
  args.push('-filter_complex', graph.join(';'), '-map', '[out]', '-t', sec(total));
  if (opts.format === 'wav') {
    args.push('-c:a', 'pcm_s16le', '-f', 'wav', opts.output);
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', opts.output);
  }
  return args;
}

export interface ChunkSliceSpan {
  sceneRowId: string;
  /** Relativos ao início do trecho. */
  startMs: number;
  endMs: number;
  /** Duração só da fala (a que entra em `buildSpeechTimeline`). */
  speechMs: number;
  /** A fatia segue para a fala seguinte DO MESMO trecho (inclui o silêncio `gapMs`). */
  joinedToNext: boolean;
}

/**
 * Fatias por fala (D8): a fatia `i` cobre `[start_i, start_{i+1})` (fala + silêncio seguinte); a
 * última cobre `[start, audioMs]` (fala + cauda).
 */
export function planChunkSlices(chunk: ChunkSnapshot): ChunkSliceSpan[] {
  return chunk.speeches.map((speech, i) => {
    const next = chunk.speeches[i + 1];
    return {
      sceneRowId: speech.sceneRowId,
      startMs: speech.startMs,
      endMs: next ? next.startMs : chunk.audioMs,
      speechMs: speech.durationMs,
      joinedToNext: !!next,
    };
  });
}

export interface ChunkConformSlicesInput {
  videoPath: string;
  /** WAV da emenda SEM enchimento (a trilha: TTS originais nos instantes do trecho). */
  audioPath: string;
  plan: TalkConformPlan;
  slices: ChunkSliceSpan[];
  /** Duração do trecho (`audioMs`): fixa a saída inteira. */
  audioMs: number;
  /** Saída das fatias, alinhada a `slices`. */
  sliceOutputs: string[];
  /** Saída do trecho inteiro (inspeção/quadro); só gerada quando há mais de uma fatia. */
  fullOutput: string | null;
}

const VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
const AUDIO_ENCODE = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
const FAST_VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];

/**
 * Conformação do trecho E fatiamento por fala num ÚNICO passe de re-encode (D8): o vídeo do motor
 * passa por recorte de aspecto/par/30 fps/clone do último quadro uma vez, é dividido (`split`) e cada
 * fatia é um `trim`; o áudio é o WAV da emenda cortado nos mesmos instantes. Lança no plano
 * `too_short` (o chamador reprova antes).
 */
export function buildChunkConformSliceArgs(opts: ChunkConformSlicesInput): string[] {
  if (opts.plan.durationAction === 'too_short') {
    throw new Error('Plano de conformação too_short não gera comando: reprovar o clipe');
  }
  const base: string[] = [];
  if (opts.plan.crop) {
    const c = opts.plan.crop;
    base.push(`crop=${c.width}:${c.height}:${c.x}:${c.y}`);
  } else if (opts.plan.forceEvenDims) base.push(MC_TALK_EVEN_DIMS_FILTER);
  base.push(`fps=${MC_TALK_CONFORM_FPS}`, 'format=yuv420p');
  if (opts.plan.durationAction === 'pad' && opts.plan.padS > 0) {
    base.push(`tpad=stop_mode=clone:stop_duration=${opts.plan.padS.toFixed(3)}`);
  }
  const withFull = opts.fullOutput != null && opts.slices.length > 1;
  const outputs = opts.slices.length + (withFull ? 1 : 0);
  const graph: string[] = [`[0:v]${base.join(',')},split=${outputs}${labels('v', outputs)}`];
  graph.push(
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,asplit=${outputs}${labels('a', outputs)}`,
  );
  opts.slices.forEach((slice, i) => {
    graph.push(
      `[v${i}]trim=start=${sec(slice.startMs)}:end=${sec(slice.endMs)},setpts=PTS-STARTPTS[ov${i}]`,
      `[a${i}]atrim=start=${sec(slice.startMs)}:end=${sec(slice.endMs)},asetpts=PTS-STARTPTS[oa${i}]`,
    );
  });
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.videoPath,
    '-i',
    opts.audioPath,
    '-filter_complex',
    graph.join(';'),
  ];
  opts.slices.forEach((_slice, i) => {
    args.push(
      '-map',
      `[ov${i}]`,
      '-map',
      `[oa${i}]`,
      ...VIDEO_ENCODE,
      ...AUDIO_ENCODE,
      '-movflags',
      '+faststart',
      opts.sliceOutputs[i],
    );
  });
  if (withFull) {
    const last = opts.slices.length;
    args.push(
      '-map',
      `[v${last}]`,
      '-map',
      `[a${last}]`,
      '-t',
      sec(opts.audioMs),
      ...FAST_VIDEO_ENCODE,
      ...AUDIO_ENCODE,
      '-movflags',
      '+faststart',
      opts.fullOutput as string,
    );
  }
  return args;
}

function labels(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `[${prefix}${i}]`).join('');
}

/**
 * Último quadro de um clipe (PNG sem perdas) — a imagem do trecho seguinte (D7). `-update 1` sem
 * `-frames:v` regrava o mesmo arquivo a cada quadro dos últimos 0,1 s: sobra o último.
 */
export function buildLastFrameArgs(opts: { video: string; output: string }): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-sseof',
    '-0.1',
    '-i',
    opts.video,
    '-update',
    '1',
    opts.output,
  ];
}
