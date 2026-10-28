import {
  MC_TALK_CONFORM_FPS,
  TalkConformPlan,
  MC_TALK_EVEN_DIMS_FILTER,
} from './mc-talk-conform-graph';
import { ASSEMBLY_FPS } from './mc-assembly-graph';
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

/**
 * fps da grade de quadros do trecho: é o da montagem (`compose_ffmpeg` usa `ASSEMBLY_FPS`) e o da
 * conformação (`MC_TALK_CONFORM_FPS`); o corte das fatias só emenda se a grade for a mesma.
 */
export const MC_CHUNK_FPS = ASSEMBLY_FPS;

/**
 * Quadros a mais no fim de cada fatia de vídeo (além da fronteira): a cadeia de recorte do `compose_ffmpeg`
 * (chromakey + alphamerge) perde o ÚLTIMO quadro de um clipe, e a fatia seguinte assume na fronteira — o
 * excedente garante que o quadro perdido nunca é um que a janela precisa mostrar (a janela `enable` esconde
 * o resto).
 */
export const MC_CHUNK_TAIL_FRAMES = 3;

export interface ChunkSliceSpan {
  sceneRowId: string;
  /** Relativos ao início do trecho (áudio: exatos). */
  startMs: number;
  endMs: number;
  /**
   * Fronteiras do VÍDEO da fatia em QUADROS (grade de 30 fps): as de áudio arredondadas ao quadro. Cortar o
   * vídeo fora da grade faz um quadro congelar e o seguinte pular (dois quadros de movimento de uma vez);
   * alinhado, a fala seguinte continua exatamente do quadro em que a anterior parou. O áudio segue
   * sample-accurate. A última fatia termina no último quadro que cobre o áudio.
   */
  videoStartFrame: number;
  videoEndFrame: number;
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
    const endMs = next ? next.startMs : chunk.audioMs;
    return {
      sceneRowId: speech.sceneRowId,
      startMs: speech.startMs,
      endMs,
      videoStartFrame: Math.round((speech.startMs / 1000) * MC_CHUNK_FPS),
      videoEndFrame: next
        ? Math.round((endMs / 1000) * MC_CHUNK_FPS)
        : Math.ceil((endMs / 1000) * MC_CHUNK_FPS),
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
  const withFull = opts.fullOutput != null && opts.slices.length > 1;
  const outputs = opts.slices.length + (withFull ? 1 : 0);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.videoPath,
    '-i',
    opts.audioPath,
    '-filter_complex',
    sliceFilterGraph(opts, outputs).join(';'),
    ...sliceOutputArgs(opts),
    ...(withFull ? fullOutputArgs(opts) : []),
  ];
}

/** Cadeia do vídeo do motor, comum a todas as saídas: recorte, fps, formato, `tpad` do plano e a folga final. */
function conformVideoChain(plan: TalkConformPlan): string[] {
  const chain: string[] = [];
  if (plan.crop) {
    const c = plan.crop;
    chain.push(`crop=${c.width}:${c.height}:${c.x}:${c.y}`);
  } else if (plan.forceEvenDims) chain.push(MC_TALK_EVEN_DIMS_FILTER);
  chain.push(`fps=${MC_TALK_CONFORM_FPS}`, 'format=yuv420p');
  if (plan.durationAction === 'pad' && plan.padS > 0) {
    chain.push(`tpad=stop_mode=clone:stop_duration=${plan.padS.toFixed(3)}`);
  }
  // quadros de folga depois do fim do vídeo do motor (cópias do último): a última fatia de um trecho precisa
  // de `MC_CHUNK_TAIL_FRAMES` além da fronteira mesmo quando o motor entrega o clipe com a duração exata do áudio
  chain.push(
    `tpad=stop_mode=clone:stop_duration=${((MC_CHUNK_TAIL_FRAMES + 3) / MC_CHUNK_FPS).toFixed(3)}`,
  );
  return chain;
}

/** Grafo: cadeia base, `split`/`asplit` em `outputs` ramos e um `trim`/`atrim` por fatia. */
function sliceFilterGraph(opts: ChunkConformSlicesInput, outputs: number): string[] {
  const graph: string[] = [
    `[0:v]${conformVideoChain(opts.plan).join(',')},split=${outputs}${labels('v', outputs)}`,
    `[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,asplit=${outputs}${labels('a', outputs)}`,
  ];
  opts.slices.forEach((slice, i) => {
    graph.push(
      `[v${i}]trim=${videoTrim(slice)},setpts=PTS-STARTPTS[ov${i}]`,
      `[a${i}]atrim=start=${sec(slice.startMs)}:end=${sec(slice.endMs)},asetpts=PTS-STARTPTS[oa${i}]`,
    );
  });
  return graph;
}

/** `-map` e codificação de cada fatia. */
function sliceOutputArgs(opts: ChunkConformSlicesInput): string[] {
  return opts.slices.flatMap((_slice, i) => [
    '-map',
    `[ov${i}]`,
    '-map',
    `[oa${i}]`,
    ...VIDEO_ENCODE,
    ...AUDIO_ENCODE,
    '-movflags',
    '+faststart',
    opts.sliceOutputs[i],
  ]);
}

/** `-map` e codificação do trecho inteiro (último ramo do `split`), fixado em `audioMs`. */
function fullOutputArgs(opts: ChunkConformSlicesInput): string[] {
  const last = opts.slices.length;
  return [
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
  ];
}

/**
 * `trim` do vídeo de uma fatia em quadros INTEIROS: o `start` guarda o quadro com `pts ≥ start` e o `end` só
 * os quadros que TERMINAM antes dele, então ambos ficam meio quadro além da fronteira (`start` meio quadro
 * antes do 1º quadro; `end` meio quadro depois do último, mais `MC_CHUNK_TAIL_FRAMES`) — imune ao ruído de
 * ponto flutuante.
 */
function videoTrim(slice: ChunkSliceSpan): string {
  const start = (slice.videoStartFrame - 0.5) / MC_CHUNK_FPS;
  const end = (slice.videoEndFrame + MC_CHUNK_TAIL_FRAMES + 0.5) / MC_CHUNK_FPS;
  return `start=${start.toFixed(5)}:end=${end.toFixed(5)}`;
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
