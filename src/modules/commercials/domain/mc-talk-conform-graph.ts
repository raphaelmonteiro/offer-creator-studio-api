/**
 * Conformação do clipe falado ao áudio (change video-formatos-personagem,
 * design D7 "áudio é a timeline mestre") — funções PURAS; o ingest executa via
 * FfmpegRunner.
 *
 * Regras:
 * - clipe mais LONGO que o áudio → aparado no fim (`-t áudio`);
 * - clipe mais CURTO em até 300 ms → último quadro clonado (`tpad=stop_mode=clone`);
 * - clipe mais curto além disso → `clip_too_short` (classe `quality`: "boca
 *   parada"), regeração até o teto da classe; esgotado o teto, o ingest aceita
 *   o último clipe replanejando com `padMaxMs: Infinity` (último quadro
 *   clonado até o áudio) e sinaliza a cena para revisão humana;
 * - aspecto do clipe ≠ aspecto do tile (tolerância 2%) → recorte CENTRALIZADO
 *   para o aspecto do tile; nunca barras; sem recorte, largura/altura ímpares
 *   são aparadas para pares (`crop=trunc(iw/2)*2:trunc(ih/2)*2`) — yuv420p
 *   exige dimensões pares;
 * - o áudio do fornecedor é DESCARTADO e o TTS original é muxado (mesma
 *   política `replace_clip_audio` do scene_compose). Nunca `-shortest`, nunca
 *   `atempo`.
 */

/** Diferença máxima (ms) coberta pelo clone do último quadro (D7: 300 ms). */
export const MC_TALK_PAD_MAX_MS = 300;

/** Tolerância relativa entre o aspecto do clipe e o do tile (D7: 2%). */
export const MC_TALK_ASPECT_TOLERANCE = 0.02;

/** Código de erro do clipe curto demais (classe `quality`, mc-error-classes). */
export const MC_CLIP_TOO_SHORT_ERROR_CODE = 'clip_too_short';

/** fps da saída conformada (mesmo da montagem). */
export const MC_TALK_CONFORM_FPS = 30;

export type McTalkDurationAction = 'keep' | 'trim' | 'pad' | 'too_short';

export interface TalkCropBox {
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface TalkConformPlan {
  durationAction: McTalkDurationAction;
  /** Diferença áudio − vídeo (ms): positiva = clipe mais curto. */
  deltaMs: number;
  /** Segundos clonados do último quadro (só em `pad`). */
  padS: number;
  /** Recorte centralizado para o aspecto do tile; null = aspecto já casa. */
  crop: TalkCropBox | null;
  /**
   * Sem recorte de aspecto mas com largura ou altura ÍMPAR: o filtro
   * `crop=trunc(iw/2)*2:trunc(ih/2)*2` apara 1 px para que a saída (yuv420p)
   * tenha dimensões pares — as medidas registradas são sempre pares.
   */
  forceEvenDims: boolean;
  /** Dimensões da saída (após o recorte, pares). */
  outputWidth: number | null;
  outputHeight: number | null;
}

/** Filtro ffmpeg que apara largura/altura ímpares para pares (sem recorte de aspecto). */
export const MC_TALK_EVEN_DIMS_FILTER = 'crop=trunc(iw/2)*2:trunc(ih/2)*2';

function isOdd(n: number | null): boolean {
  return n != null && n % 2 !== 0;
}

export interface TalkConformInput {
  videoMs: number;
  audioMs: number;
  videoWidth: number | null;
  videoHeight: number | null;
  /** Dimensões do tile de fala; ausentes = sem checagem de aspecto. */
  tileWidth: number | null;
  tileHeight: number | null;
  padMaxMs?: number;
  aspectTolerance?: number;
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Recorte centralizado para o aspecto alvo (largura/altura pares); null quando dentro da tolerância. */
export function centerCropToAspect(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  tolerance: number = MC_TALK_ASPECT_TOLERANCE,
): TalkCropBox | null {
  if (width <= 0 || height <= 0 || targetWidth <= 0 || targetHeight <= 0) return null;
  const actual = width / height;
  const target = targetWidth / targetHeight;
  if (Math.abs(actual - target) / target <= tolerance) return null;
  if (actual > target) {
    // clipe mais largo que o tile: corta as laterais
    const cropWidth = even(height * target);
    return { width: cropWidth, height: even(height), x: Math.floor((width - cropWidth) / 2), y: 0 };
  }
  // clipe mais alto que o tile: corta topo/base
  const cropHeight = even(width / target);
  return { width: even(width), height: cropHeight, x: 0, y: Math.floor((height - cropHeight) / 2) };
}

/** Decisão pura da conformação (duração + geometria) a partir das medidas do probe. */
export function planTalkConform(input: TalkConformInput): TalkConformPlan {
  const padMaxMs = input.padMaxMs ?? MC_TALK_PAD_MAX_MS;
  const deltaMs = Math.round(input.audioMs - input.videoMs);
  let durationAction: McTalkDurationAction;
  if (deltaMs < 0) durationAction = 'trim';
  else if (deltaMs === 0) durationAction = 'keep';
  else if (deltaMs <= padMaxMs) durationAction = 'pad';
  else durationAction = 'too_short';
  const crop =
    input.videoWidth != null &&
    input.videoHeight != null &&
    input.tileWidth != null &&
    input.tileHeight != null
      ? centerCropToAspect(
          input.videoWidth,
          input.videoHeight,
          input.tileWidth,
          input.tileHeight,
          input.aspectTolerance ?? MC_TALK_ASPECT_TOLERANCE,
        )
      : null;
  const outputWidth = crop?.width ?? (input.videoWidth != null ? even(input.videoWidth) : null);
  const outputHeight = crop?.height ?? (input.videoHeight != null ? even(input.videoHeight) : null);
  return {
    durationAction,
    deltaMs,
    // margem de 1 quadro a 30 fps: o -t do áudio corta o excesso, nunca falta quadro
    padS:
      durationAction === 'pad' ? Number((deltaMs / 1000 + 1 / MC_TALK_CONFORM_FPS).toFixed(3)) : 0,
    crop,
    // o recorte de aspecto já sai par (`even`); sem ele, ímpar precisa do filtro
    forceEvenDims: crop == null && (isOdd(input.videoWidth) || isOdd(input.videoHeight)),
    outputWidth,
    outputHeight,
  };
}

export interface TalkConformArgsOptions {
  videoPath: string;
  audioPath: string;
  output: string;
  plan: TalkConformPlan;
  /** Duração MEDIDA do áudio (segundos, fracionário) — fixa a saída. */
  audioDurationS: number;
}

/**
 * Argumentos do ffmpeg: vídeo re-encodado (recorte/clone exigem filtro),
 * áudio = TTS original como única trilha (AAC 48 kHz estéreo, `apad` cobre
 * jitter de probe), `-t` prende a saída à duração do ÁUDIO. Lança quando o
 * plano é `too_short` — o chamador decide a reprovação antes de chegar aqui.
 */
export function buildTalkConformArgs(opts: TalkConformArgsOptions): string[] {
  if (opts.plan.durationAction === 'too_short') {
    throw new Error('Plano de conformação too_short não gera comando: reprovar o clipe');
  }
  const filters: string[] = [];
  const crop = opts.plan.crop;
  if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  else if (opts.plan.forceEvenDims) filters.push(MC_TALK_EVEN_DIMS_FILTER);
  filters.push(`fps=${MC_TALK_CONFORM_FPS}`, 'format=yuv420p');
  if (opts.plan.durationAction === 'pad' && opts.plan.padS > 0) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${opts.plan.padS.toFixed(3)}`);
  }
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.videoPath,
    '-i',
    opts.audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-vf',
    filters.join(','),
    '-af',
    'apad',
    '-t',
    opts.audioDurationS.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    opts.output,
  ];
}

/** Tolerância (ms) entre a saída conformada e o áudio (jitter de encoder/probe). */
export const MC_TALK_CONFORM_TOLERANCE_MS = 120;

/** Verificação do ARQUIVO conformado: vídeo + áudio presentes e duração = áudio. */
export function conformedOutputIssue(
  probe: { hasVideo: boolean; hasAudio: boolean; durationMs: number | null },
  audioMs: number,
  toleranceMs: number = MC_TALK_CONFORM_TOLERANCE_MS,
): string | null {
  if (!probe.hasVideo) return 'conformed_without_video';
  if (!probe.hasAudio) return 'conformed_without_audio';
  if (probe.durationMs != null && Math.abs(probe.durationMs - audioMs) > toleranceMs) {
    return 'conformed_duration_mismatch';
  }
  return null;
}

// ───────────────────────── timeline das falas (D7) ─────────────────────────

/** Silêncio entre falas consecutivas na composição (D7: 150–250 ms). */
export const MC_TALK_GAP_MS = 200;

export interface SpeechTimelineEntry {
  sceneId: string;
  startMs: number;
  endMs: number;
}

/**
 * Instantes de cada fala na timeline = soma das durações MEDIDAS anteriores
 * mais os silêncios entre falas (nunca os planejados). Ex.: 6 s, 7 s e 5 s →
 * a terceira começa em 13,4 s e o vídeo falado dura 18,4 s. A composição
 * (compose_ffmpeg / render_remotion) consome isto; o crossfade ≤ 200 ms não
 * muda os instantes (ele se sobrepõe ao silêncio).
 */
export function buildSpeechTimeline(
  speeches: Array<{ sceneId: string; durationMs: number }>,
  gapMs: number = MC_TALK_GAP_MS,
): { entries: SpeechTimelineEntry[]; totalMs: number } {
  const entries: SpeechTimelineEntry[] = [];
  let cursor = 0;
  for (const [i, speech] of speeches.entries()) {
    if (i > 0) cursor += gapMs;
    const startMs = cursor;
    const endMs = startMs + Math.max(0, Math.round(speech.durationMs));
    entries.push({ sceneId: speech.sceneId, startMs, endMs });
    cursor = endMs;
  }
  return { entries, totalMs: cursor };
}
