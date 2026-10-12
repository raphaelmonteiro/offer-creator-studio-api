import { buildTimedDrawtext, DrawTextStyle, MUSIC_BASE_VOLUME } from './mc-assembly-graph';
import { TextCue } from './mc-captions';
import { safeAreaFor, WindowPx } from './mc-talking-art-window';
import { McProjectChannel } from './mc-types';

/**
 * Grafo de finalização dos formatos novos (change video-formatos-personagem,
 * D8/D13; tarefa 4.5) — funções PURAS; o `McFinalizeProcessor` executa via
 * FfmpegRunner. Parte do vídeo COMPOSTO (`compose_ffmpeg`) e entrega:
 *
 * - LEGENDAS por linha (≤ 38 caracteres, `buildCaptionCues` dos timestamps do
 *   TTS) com `buildTimedDrawtext` (contorno UTF-8 do drawtext incluso), numa
 *   faixa DENTRO da área segura: base da área segura, ou topo dela quando a
 *   janela do personagem ocupa a base; corpo único por vídeo, dimensionado
 *   para a linha mais longa caber na largura segura.
 * - DUCKING determinístico: a trilha (volume base) recebe, por janela de fala
 *   (derivada dos timestamps), um `volume` com `enable='between(t,a,b)'` e
 *   rampas lineares em dB (ataque antes da fala, liberação depois) de
 *   −15 dB — nada de compressor sidechain; janelas próximas são fundidas para
 *   a música não "bombear" entre palavras. Mistura `amix normalize=0`.
 * - LOUDNESS em duas passagens: passe 1 MEDE a mistura (BS.1770 via
 *   `ebur128` com metadados gravados em arquivo pelo `ametadata`: I, LRA e
 *   pico real — o runner não devolve stderr, onde o `loudnorm` imprime o
 *   JSON; os números são os mesmos que o `loudnorm` usaria); passe 2 aplica
 *   `loudnorm` LINEAR com os valores medidos (alvo −14 LUFS, teto −1 dBTP com
 *   1 dB de folga para o overshoot do AAC, LRA 11 — elevado ao LRA medido só
 *   para manter o modo linear: compressão dinâmica desfaria o ducking) e
 *   `-ar 48000`; passe 3 mede a ENTREGA (registrada no asset).
 * - PERFIS por canal: Instagram H.264 High 4.1, 30 fps CFR, GOP 30 fechado,
 *   CRF com teto de 20 Mbps, `+faststart`, AAC 48 kHz 128 kbps; WhatsApp Main
 *   sem B-frames, bitrate calculado para ≤ 16 MB pela duração (reduz bitrate
 *   antes de reduzir resolução).
 */

/** Versão do grafo de finalização: entra no hash do finalize. 2 = legendas + ducking + loudnorm 2 passes + perfis (4.5). */
export const MC_FINALIZE_GRAPH_VERSION = 2;

/** Alvo de loudness da entrega (spec "Mix de áudio"): −14 LUFS integrado, −1 dBTP. */
export const MC_FINALIZE_LOUDNESS = { I: -14, TP: -1 } as const;

/** LRA alvo do loudnorm (D13). */
export const MC_FINALIZE_LRA = 11;

/** Folga de pico (dB) para o overshoot do encoder AAC: o loudnorm mira TP − 1. */
export const MC_FINALIZE_TP_HEADROOM_DB = 1;

/** Margem (dB) entre pico amostral do limitador e pico real (inter-sample). */
export const MC_FINALIZE_LIMITER_MARGIN_DB = 0.5;

/** Ducking: atenuação da trilha nas janelas de fala (spec: ≥ 12 LU; 15 dá margem às rampas). */
export const MC_DUCK_ATTENUATION_DB = 15;
/** Rampa de ataque (s) ANTES da fala e de liberação (s) DEPOIS dela. */
export const MC_DUCK_ATTACK_S = 0.12;
export const MC_DUCK_RELEASE_S = 0.25;
/** Pausas mais curtas que ataque + liberação + isto ficam abafadas (sem "bombear"). */
export const MC_DUCK_MERGE_EXTRA_S = 0.15;

export interface SpeechWindowInput {
  sceneId: string;
  startS: number;
  endS: number;
}

/** Snapshot de entrada do finalize (gravado no step). */
export interface FinalizeGraphInput {
  /** Caminho absoluto do vídeo composto (saída do compose_ffmpeg). */
  sourcePath: string;
  output: string;
  channel: McProjectChannel | null;
  /** Dimensões do composto (px) — legendas e perfil do WhatsApp. */
  width: number;
  height: number;
  /** Trilha instrumental já resolvida; null = sem música. */
  musicPath: string | null;
  /** Janelas de fala na timeline (dos timestamps; ducking). */
  speechWindows: SpeechWindowInput[];
  /** Legendas por linha (≤ 38 caracteres) com instantes absolutos. */
  captionCues: TextCue[];
  /** Janela do personagem em px (a faixa de legenda evita cobri-la); null = desconhecida. */
  windowPx?: WindowPx | null;
  loudness: { I: number; TP: number };
  /** Duração do composto (ms) — base do progresso e do bitrate do WhatsApp. */
  durationMs: number;
}

// ───────────────────────────── perfis (D13) ─────────────────────────────

/** Teto do arquivo no WhatsApp (16 MB decimais — o mais restritivo). */
export const MC_WHATSAPP_MAX_BYTES = 16_000_000;
/** Fração do teto usada pelo bitrate (overhead do contêiner e do AAC). */
export const MC_WHATSAPP_SIZE_SAFETY = 0.95;
/** Bitrate de vídeo máximo no WhatsApp (o app recomprime; mais que isso é desperdício). */
export const MC_WHATSAPP_MAX_VIDEO_KBPS = 5000;
/** Piso de bitrate de vídeo. */
export const MC_WHATSAPP_MIN_VIDEO_KBPS = 200;
export const MC_FINALIZE_AUDIO_KBPS = 128;

/**
 * Degraus de resolução do WhatsApp: o bitrate cai primeiro; a resolução só
 * desce quando o bitrate que cabe nos 16 MB fica abaixo do mínimo do degrau.
 */
export const MC_WHATSAPP_RUNGS: ReadonlyArray<{ scale: number; minKbps: number }> = [
  { scale: 1, minKbps: 1500 },
  { scale: 2 / 3, minKbps: 800 },
  { scale: 1 / 2, minKbps: 0 },
];

export interface EncodeProfile {
  channel: McProjectChannel;
  profile: 'high' | 'main';
  level: '4.1' | '4.0';
  /** B-frames: 0 no WhatsApp (Main sem B-frames, D13). */
  bframes: number;
  fps: number;
  /** GOP fechado de 1 s a 30 fps (`-g 30 -keyint_min 30 -sc_threshold 0 -flags +cgop`). */
  gop: number;
  /** CRF (Instagram); null = bitrate alvo (WhatsApp). */
  crf: number | null;
  /** Bitrate de vídeo alvo (WhatsApp); null no Instagram. */
  videoBitrateKbps: number | null;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrate: string;
  audioRate: number;
  /** Resolução de saída (WhatsApp pode reduzir). */
  width: number;
  height: number;
  /** Teto do arquivo (bytes); null = sem teto. */
  maxBytes: number | null;
}

/**
 * Bitrate de vídeo (kbps) para caber em 16 MB: orçamento × segurança − áudio,
 * dividido pela duração + 1 s (pior caso do VBV com maxrate = bufsize =
 * bitrate). `factor` < 1 = nova tentativa mais conservadora.
 */
export function whatsappVideoBitrateKbps(durationS: number, factor = 1): number {
  const d = Math.max(1, durationS);
  const budgetBits = MC_WHATSAPP_MAX_BYTES * 8 * MC_WHATSAPP_SIZE_SAFETY;
  const audioBits = MC_FINALIZE_AUDIO_KBPS * 1000 * d;
  const fit = (budgetBits - audioBits) / (d + 1) / 1000;
  const kbps = Math.floor(Math.min(MC_WHATSAPP_MAX_VIDEO_KBPS, fit) * factor);
  return Math.max(MC_WHATSAPP_MIN_VIDEO_KBPS, kbps);
}

/** Bitrate e resolução do WhatsApp: reduz bitrate antes de reduzir resolução. */
export function planWhatsappEncode(
  durationS: number,
  width: number,
  height: number,
  factor = 1,
): { videoKbps: number; width: number; height: number; downscaled: boolean } {
  const videoKbps = whatsappVideoBitrateKbps(durationS, factor);
  const rung =
    MC_WHATSAPP_RUNGS.find((r) => videoKbps >= r.minKbps) ??
    MC_WHATSAPP_RUNGS[MC_WHATSAPP_RUNGS.length - 1];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return {
    videoKbps,
    width: rung.scale === 1 ? width : even(width * rung.scale),
    height: rung.scale === 1 ? height : even(height * rung.scale),
    downscaled: rung.scale !== 1,
  };
}

/** Perfil de encode por canal (D13); sem canal = Instagram. */
export function encodeProfileFor(
  channel: McProjectChannel | null | undefined,
  frame: { durationS: number; width: number; height: number } = {
    durationS: 30,
    width: 1080,
    height: 1920,
  },
  opts: { bitrateFactor?: number } = {},
): EncodeProfile {
  if (channel === 'whatsapp') {
    const wa = planWhatsappEncode(frame.durationS, frame.width, frame.height, opts.bitrateFactor);
    return {
      channel: 'whatsapp',
      profile: 'main',
      level: '4.0',
      bframes: 0,
      fps: 30,
      gop: 30,
      crf: null,
      videoBitrateKbps: wa.videoKbps,
      maxrateKbps: wa.videoKbps,
      bufsizeKbps: wa.videoKbps,
      audioBitrate: `${MC_FINALIZE_AUDIO_KBPS}k`,
      audioRate: 48000,
      width: wa.width,
      height: wa.height,
      maxBytes: MC_WHATSAPP_MAX_BYTES,
    };
  }
  return {
    channel: 'instagram',
    profile: 'high',
    level: '4.1',
    bframes: 2,
    fps: 30,
    gop: 30,
    crf: 18,
    videoBitrateKbps: null,
    maxrateKbps: 20_000,
    bufsizeKbps: 30_000,
    audioBitrate: `${MC_FINALIZE_AUDIO_KBPS}k`,
    audioRate: 48000,
    width: frame.width,
    height: frame.height,
    maxBytes: null,
  };
}

/** Argumentos de encode do perfil (vídeo + áudio + faststart). */
export function encodeArgsFor(profile: EncodeProfile): string[] {
  const video = [
    '-c:v',
    'libx264',
    '-profile:v',
    profile.profile,
    '-level:v',
    profile.level,
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
  ];
  if (profile.crf != null) video.push('-crf', String(profile.crf));
  else video.push('-b:v', `${profile.videoBitrateKbps}k`);
  video.push(
    '-maxrate',
    `${profile.maxrateKbps}k`,
    '-bufsize',
    `${profile.bufsizeKbps}k`,
    '-bf',
    String(profile.bframes),
    '-g',
    String(profile.gop),
    '-keyint_min',
    String(profile.gop),
    '-sc_threshold',
    '0',
    '-flags',
    '+cgop',
    '-r',
    String(profile.fps),
  );
  return [
    ...video,
    '-c:a',
    'aac',
    '-b:a',
    profile.audioBitrate,
    '-ar',
    String(profile.audioRate),
    '-ac',
    '2',
    '-movflags',
    '+faststart',
  ];
}

// ───────────────────────────── legendas ─────────────────────────────

/** Avanço médio de glifo (em corpos) para linhas em caixa mista na DejaVu Sans, com folga. */
export const CAPTION_GLYPH_RATIO = 0.62;
/** Fração da largura segura que a linha mais longa pode ocupar. */
export const CAPTION_SAFE_WIDTH_RATIO = 0.92;
export const CAPTION_MIN_FONT_PX = 24;

export interface CaptionLayout {
  style: DrawTextStyle;
  /** Faixa vertical da legenda em px (máscara do PSNR, auditoria). */
  band: { top: number; bottom: number; left: number; right: number };
  position: 'bottom' | 'top';
}

/**
 * Faixa e estilo das legendas por linha DENTRO da área segura: corpo único
 * (a linha mais longa, ≤ 38 caracteres, cabe em 92% da largura segura), base
 * da área segura — ou topo dela quando a janela do personagem invade a faixa
 * de baixo e não invade a de cima.
 */
export function captionLayoutFor(
  width: number,
  height: number,
  cues: TextCue[],
  windowPx: WindowPx | null = null,
): CaptionLayout {
  const safe = safeAreaFor(width, height);
  const safeW = safe.right - safe.left;
  // as cues já vêm em linhas de ≤ 38 caracteres (buildCaptionCues); uma linha
  // maior encolhe o corpo em vez de vazar da área segura.
  const longest = Math.max(1, ...cues.map((c) => [...(c.text ?? '')].length));
  const base = Math.round(Math.min(width, height) / 22);
  const byWidth = Math.floor((safeW * CAPTION_SAFE_WIDTH_RATIO) / (longest * CAPTION_GLYPH_RATIO));
  const fontSize = Math.max(CAPTION_MIN_FONT_PX, Math.min(base, byWidth));
  const boxBorder = Math.max(8, Math.round(fontSize * 0.35));
  const bandHeight = Math.round(fontSize * 1.3) + 2 * boxBorder;
  const bottomBand = { top: safe.bottom - bandHeight, bottom: safe.bottom };
  const topBand = { top: safe.top, bottom: safe.top + bandHeight };
  const hits = (band: { top: number; bottom: number }) =>
    !!windowPx &&
    windowPx.y < band.bottom &&
    windowPx.y + windowPx.height > band.top &&
    windowPx.x < safe.right &&
    windowPx.x + windowPx.width > safe.left;
  const position: 'bottom' | 'top' = hits(bottomBand) && !hits(topBand) ? 'top' : 'bottom';
  const band = position === 'bottom' ? bottomBand : topBand;
  return {
    style: {
      fontSize,
      y: position === 'bottom' ? `${band.bottom - boxBorder}-text_h` : String(band.top + boxBorder),
      boxColor: 'black@0.6',
      boxBorder,
    },
    band: { ...band, left: safe.left, right: safe.right },
    position,
  };
}

/**
 * Cues prontas para queimar: texto não vazio, ordenadas, e o fim de cada uma
 * preso ao início da seguinte (a duração mínima de `buildCaptionCues` pode
 * empurrar uma linha sobre a próxima — duas caixas no mesmo lugar).
 */
export function sanitizeCaptionCues(cues: TextCue[]): TextCue[] {
  const sorted = (cues ?? [])
    .filter((c) => c?.text?.trim() && Number.isFinite(c.startS) && Number.isFinite(c.endS))
    .map((c) => ({ text: c.text, startS: c.startS, endS: c.endS }))
    .sort((a, b) => a.startS - b.startS);
  return sorted
    .map((cue, i) => {
      const next = sorted[i + 1];
      return next && next.startS < cue.endS ? { ...cue, endS: next.startS } : cue;
    })
    .filter((c) => c.endS > c.startS);
}

// ───────────────────────────── ducking ─────────────────────────────

export interface DuckWindow {
  startS: number;
  endS: number;
}

/** Janelas de fala ordenadas e fundidas quando a pausa não comporta ataque + liberação. */
export function mergeSpeechWindows(
  windows: Array<{ startS: number; endS: number }>,
  opts: { attackS?: number; releaseS?: number; extraS?: number } = {},
): DuckWindow[] {
  const minGap =
    (opts.attackS ?? MC_DUCK_ATTACK_S) +
    (opts.releaseS ?? MC_DUCK_RELEASE_S) +
    (opts.extraS ?? MC_DUCK_MERGE_EXTRA_S);
  const sorted = windows
    .filter((w) => Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.endS > w.startS)
    .map((w) => ({ startS: Math.max(0, w.startS), endS: w.endS }))
    .sort((a, b) => a.startS - b.startS);
  const merged: DuckWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.startS - last.endS < minGap) last.endS = Math.max(last.endS, w.endS);
    else merged.push({ ...w });
  }
  return merged.map((w) => ({
    startS: Number(w.startS.toFixed(3)),
    endS: Number(w.endS.toFixed(3)),
  }));
}

const f3 = (n: number) => Number(n.toFixed(3)).toString();

/**
 * Envelope de ganho determinístico da trilha: um `volume` por janela, ligado
 * só em [início − ataque, fim + liberação] (`enable=between`), com rampa
 * linear em dB nas bordas e −D dB no miolo (`eval=frame`). Fora das janelas a
 * trilha passa intacta — o nível base volta exatamente nas pausas.
 */
export function buildDuckingFilters(
  windows: DuckWindow[],
  opts: { attenuationDb?: number; attackS?: number; releaseS?: number } = {},
): string[] {
  const D = opts.attenuationDb ?? MC_DUCK_ATTENUATION_DB;
  const attack = opts.attackS ?? MC_DUCK_ATTACK_S;
  const release = opts.releaseS ?? MC_DUCK_RELEASE_S;
  return windows.map((w) => {
    const from = w.startS - attack; // pode ser negativo: fala em t=0 já começa abafada
    const to = w.endS + release;
    const ramp = `min(1,min((t-(${f3(from)}))/${f3(attack)},(${f3(to)}-t)/${f3(release)}))`;
    return (
      `volume='pow(10,-${D}*${ramp}/20)':eval=frame:` +
      `enable='between(t,${f3(Math.max(0, from))},${f3(to)})'`
    );
  });
}

// ───────────────────────────── loudness ─────────────────────────────

export interface LoudnessMeasurement {
  /** Loudness integrada (LUFS). */
  I: number;
  /** Pico real (dBTP). */
  TP: number;
  /** Faixa de loudness (LU). */
  LRA: number;
  /** Limiar relativo de gating (LUFS) — ≈ I − 10 quando a medição não o traz. */
  thresh: number;
}

export interface LoudnormPlan {
  filters: string[];
  /** Ganho linear previsto (dB) = alvo − medido. */
  gainDb: number;
  /**
   * `dynamic` quando não houve medição utilizável (mistura em silêncio) ou o
   * pico ainda passaria do teto depois das re-medições — o próprio loudnorm
   * cai no modo dinâmico (com limitador de pico real) nesse caso.
   */
  mode: 'linear' | 'linear_limited' | 'dynamic';
  /** Teto do limitador aplicado (dBFS amostral, antes do ganho); null = sem limitador. */
  limiterDb: number | null;
  /**
   * Teto de limitador que a PRÓXIMA medição deve usar (o pico previsto ainda
   * passa do teto); null = plano final. O processor mede de novo a mistura
   * limitada e replaneja — o limitador tira loudness, então o ganho cresce.
   */
  nextLimiterDb: number | null;
  /** LRA passado ao loudnorm (≥ 11; = LRA medido + 1 quando maior, para manter o modo linear). */
  lra: number;
  /** Teto de pico real usado (alvo − folga do codec). */
  ceilingTp: number;
  /** Pico real previsto depois do ganho (medido + ganho), dBTP. */
  predictedTp: number;
}

/** Faixa aceita pelo `alimiter` (limit 0,0625–1 → −24..0 dBFS). */
const LIMITER_MIN_DB = -24;

function clampLimiterDb(db: number): number {
  return Number(Math.min(0, Math.max(LIMITER_MIN_DB, db)).toFixed(2));
}

/** `alimiter` sem auto-nível (o ganho é do loudnorm), ataque 5 ms. */
export function limiterFilter(limiterDb: number): string {
  const limit = Math.pow(10, clampLimiterDb(limiterDb) / 20);
  return `alimiter=limit=${limit.toFixed(5)}:attack=5:release=50:level=0`;
}

/**
 * Passe 2 do loudness a partir da medição: `loudnorm` LINEAR (ganho constante
 * = alvo − medido, preserva o ducking), teto de pico = alvo − 1 dB de folga do
 * AAC, LRA elevado ao medido só para não cair no modo dinâmico.
 *
 * Pico previsto (medido + ganho) acima do teto ⇒ `alimiter` ANTES do ganho.
 * Como limitar tira loudness, a medição que vale é a da mistura JÁ limitada:
 * sem `limiterDb` o plano devolve `nextLimiterDb` (o processor mede de novo
 * com o limitador e chama outra vez passando `limiterDb`); com `limiterDb`, a
 * medição é a da mistura limitada e, se o pico ainda passar, o limitador desce
 * o excedente (`nextLimiterDb`). Converge em 1–2 medições extras.
 */
export function planLoudnorm(
  measured: LoudnessMeasurement,
  target: { I: number; TP: number } = MC_FINALIZE_LOUDNESS,
  opts: { limiterDb?: number | null } = {},
): LoudnormPlan {
  const ceilingTp = target.TP - MC_FINALIZE_TP_HEADROOM_DB;
  const gainDb = target.I - measured.I;
  const lra = Math.min(50, Math.max(MC_FINALIZE_LRA, Math.ceil(measured.LRA + 1)));
  const predictedTp = measured.TP + gainDb;
  const current = opts.limiterDb ?? null;
  let nextLimiterDb: number | null = null;
  if (current == null && predictedTp > ceilingTp) {
    nextLimiterDb = clampLimiterDb(ceilingTp - gainDb - MC_FINALIZE_LIMITER_MARGIN_DB);
  } else if (current != null && predictedTp > ceilingTp + 0.1) {
    const lowered = clampLimiterDb(current - (predictedTp - ceilingTp) - 0.1);
    nextLimiterDb = lowered < current ? lowered : null;
  }
  const filters: string[] = [];
  if (current != null) filters.push(limiterFilter(current));
  filters.push(
    `loudnorm=I=${target.I}:TP=${ceilingTp}:LRA=${lra}:linear=true:` +
      `measured_I=${measured.I.toFixed(2)}:measured_TP=${measured.TP.toFixed(2)}:` +
      `measured_LRA=${measured.LRA.toFixed(2)}:measured_thresh=${measured.thresh.toFixed(2)}`,
  );
  return {
    filters,
    gainDb: Number(gainDb.toFixed(2)),
    mode: current == null ? 'linear' : 'linear_limited',
    limiterDb: current == null ? null : clampLimiterDb(current),
    nextLimiterDb,
    lra,
    ceilingTp,
    predictedTp: Number(predictedTp.toFixed(2)),
  };
}

/** Plano de reserva sem medição utilizável: loudnorm de uma passagem (modo dinâmico). */
export function dynamicLoudnormPlan(
  target: { I: number; TP: number } = MC_FINALIZE_LOUDNESS,
): LoudnormPlan {
  const ceilingTp = target.TP - MC_FINALIZE_TP_HEADROOM_DB;
  return {
    filters: [`loudnorm=I=${target.I}:TP=${ceilingTp}:LRA=${MC_FINALIZE_LRA}`],
    gainDb: 0,
    mode: 'dynamic',
    limiterDb: null,
    nextLimiterDb: null,
    lra: MC_FINALIZE_LRA,
    ceilingTp,
    predictedTp: ceilingTp,
  };
}

/**
 * Re-medições máximas com limitador. Converge geometricamente (cada passo tira
 * o excesso de pico e perde só parte dele em loudness): 1–2 para fala, até 4
 * em sinais de crista extrema (medido na fixture com cliques). Cada uma é um
 * passe só de áudio (~0,3 s).
 */
export const MC_LOUDNORM_MAX_REMEASURES = 5;

export interface ResolvedLoudnorm {
  loudnorm: LoudnormPlan;
  /** Medição do passe 1 (mistura crua); null = silêncio. */
  pass1: LoudnessMeasurement | null;
  /** Medições feitas, na ordem (a última é a que o loudnorm usa). */
  measurements: Array<{ limiterDb: number | null; measured: LoudnessMeasurement | null }>;
}

/**
 * Passe 1 completo: mede a mistura, planeja o loudnorm linear e, enquanto o
 * plano pedir limitador (`nextLimiterDb`), mede de novo a mistura limitada e
 * replaneja. `measureWith` executa o passe e lê o arquivo de metadados (o
 * processor e a fixture injetam o executor; a decisão fica aqui, pura).
 */
export async function resolveLoudnormPlan(
  measure: (limiterDb?: number | null) => FinalizeMeasurePass,
  measureWith: (pass: FinalizeMeasurePass) => Promise<LoudnessMeasurement | null>,
  target: { I: number; TP: number } = MC_FINALIZE_LOUDNESS,
): Promise<ResolvedLoudnorm> {
  const measurements: ResolvedLoudnorm['measurements'] = [];
  const pass1 = await measureWith(measure(null));
  measurements.push({ limiterDb: null, measured: pass1 });
  if (!pass1) return { loudnorm: dynamicLoudnormPlan(target), pass1, measurements };
  let plan = planLoudnorm(pass1, target);
  for (let i = 0; i < MC_LOUDNORM_MAX_REMEASURES && plan.nextLimiterDb != null; i += 1) {
    const limiterDb = plan.nextLimiterDb;
    const limited = await measureWith(measure(limiterDb));
    measurements.push({ limiterDb, measured: limited });
    if (!limited) break;
    plan = planLoudnorm(limited, target, { limiterDb });
  }
  // sem convergir (teto de re-medições ou limitador no mínimo), o loudnorm
  // recusa o modo linear (pico previsto > teto) e normaliza no dinâmico —
  // registrado como tal, nunca como "linear".
  if (plan.predictedTp > plan.ceilingTp + 0.1) plan = { ...plan, mode: 'dynamic' };
  return { loudnorm: plan, pass1, measurements };
}

/** Valor de opção de filtro com caminho de arquivo (aspas no grafo, `:` e `\` escapados na opção). */
export function filterPathValue(file: string): string {
  if (file.includes("'")) throw new Error(`Caminho com aspas não suportado no filtro: ${file}`);
  return `'${file.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}'`;
}

/** Medição BS.1770 gravada em arquivo (o runner não devolve stderr): I, LRA e picos reais. */
export function ebur128MeasureChain(metadataPath: string): string {
  return `ebur128=peak=true:metadata=1,ametadata=mode=print:file=${filterPathValue(metadataPath)}`;
}

/**
 * Lê o arquivo do `ametadata` (blocos `frame:N pts:… pts_time:…` + `chave=valor`):
 * o ÚLTIMO bloco traz a integrada, o LRA e os picos reais acumulados (lineares
 * → dBTP). null quando não há medição utilizável (ex.: só silêncio).
 */
export function parseEbur128Metadata(text: string): LoudnessMeasurement | null {
  let I: number | null = null;
  let LRA: number | null = null;
  let peak = 0;
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line.startsWith('lavfi.r128.') || eq < 0) continue;
    const key = line.slice('lavfi.r128.'.length, eq);
    const value = Number(line.slice(eq + 1));
    if (!Number.isFinite(value)) continue;
    if (key === 'I') I = value;
    else if (key === 'LRA') LRA = value;
    else if (key === 'true_peak' || key.startsWith('true_peaks_ch')) peak = Math.max(peak, value);
  }
  if (I == null || !(I > -70)) return null;
  const TP = peak > 0 ? 20 * Math.log10(peak) : -70;
  return {
    I: Number(I.toFixed(2)),
    TP: Number(TP.toFixed(2)),
    LRA: Number((LRA ?? 0).toFixed(2)),
    thresh: Number((I - 10).toFixed(2)),
  };
}

/** Medição de um arquivo pronto (passe 3: a entrega). */
export function buildLoudnessProbeArgs(file: string, metadataPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    file,
    '-vn',
    '-af',
    `aresample=48000,${ebur128MeasureChain(metadataPath)}`,
    '-f',
    'null',
    '-',
  ];
}

/** A entrega cumpre o alvo? (spec: −15..−13 LUFS e pico real ≤ −1 dBTP). */
export function loudnessWithinTarget(
  m: Pick<LoudnessMeasurement, 'I' | 'TP'>,
  target: { I: number; TP: number } = MC_FINALIZE_LOUDNESS,
): boolean {
  return Math.abs(m.I - target.I) <= 1 && m.TP <= target.TP;
}

// ───────────────────────────── grafo ─────────────────────────────

const AUDIO_FMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/** Cadeias de áudio até `[mix]`: fala (+ trilha com volume base e envelope de ducking). */
export function buildMixChains(input: FinalizeGraphInput): {
  chains: string[];
  duck: DuckWindow[];
} {
  const chains = [`[0:a]aresample=48000,${AUDIO_FMT}[speech]`];
  if (!input.musicPath) {
    chains.push('[speech]anull[mix]');
    return { chains, duck: [] };
  }
  const duck = mergeSpeechWindows(input.speechWindows);
  const music = [
    `aresample=48000`,
    AUDIO_FMT,
    `volume=${MUSIC_BASE_VOLUME}`,
    ...buildDuckingFilters(duck),
  ];
  chains.push(`[1:a]${music.join(',')}[music]`);
  chains.push('[speech][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]');
  return { chains, duck };
}

function inputArgs(input: FinalizeGraphInput): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input.sourcePath];
  if (input.musicPath) args.push('-i', input.musicPath);
  return args;
}

export interface FinalizeRenderOptions {
  /** < 1 refaz o WhatsApp com bitrate menor quando o arquivo passou do teto. */
  bitrateFactor?: number;
}

export interface FinalizeRender {
  args: string[];
  profile: EncodeProfile;
}

export interface FinalizeMeasurePass {
  args: string[];
  metadataPath: string;
}

export interface FinalizeGraphPlan {
  output: string;
  durationMs: number;
  /** Perfil nominal do canal (o render pode refazer o WhatsApp com bitrate menor). */
  profile: EncodeProfile;
  captions: { count: number; layout: CaptionLayout | null };
  /** Janelas de ducking efetivas (fundidas); vazio sem trilha. */
  ducking: DuckWindow[];
  /**
   * Passe 1: mede a mistura (sem loudnorm) — com `limiterDb`, a mistura já
   * limitada (re-medição do `planLoudnorm.nextLimiterDb`).
   */
  measure: (limiterDb?: number | null) => FinalizeMeasurePass;
  /** Passe 2: render com legendas, mistura, plano de loudnorm (linear, medido) e perfil do canal. */
  render: (loudnorm: LoudnormPlan, opts?: FinalizeRenderOptions) => FinalizeRender;
  /** Passe 3: mede a entrega. */
  verify: FinalizeMeasurePass;
}

function dirOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i > 0 ? file.slice(0, i) : '.';
}

/** Plano do finalize: medição, render (com a medição) e verificação da entrega. */
export function buildFinalizeGraph(input: FinalizeGraphInput): FinalizeGraphPlan {
  const durationS = Math.max(0.1, input.durationMs / 1000);
  const frame = { durationS, width: input.width, height: input.height };
  const profile = encodeProfileFor(input.channel, frame);
  const { chains, duck } = buildMixChains(input);
  const cues = sanitizeCaptionCues(input.captionCues);
  const layout =
    cues.length > 0
      ? captionLayoutFor(input.width, input.height, cues, input.windowPx ?? null)
      : null;
  const dir = dirOf(input.output);
  const verifyPath = `${dir}/loudness-final.txt`;

  const measure = (limiterDb: number | null = null): FinalizeMeasurePass => {
    const metadataPath =
      limiterDb == null
        ? `${dir}/loudness-pass1.txt`
        : `${dir}/loudness-pass1-lim${Math.round(Math.abs(limiterDb) * 100)}.txt`;
    const pre = limiterDb == null ? '' : `${limiterFilter(limiterDb)},`;
    return {
      metadataPath,
      args: [
        ...inputArgs(input),
        '-filter_complex',
        [...chains, `[mix]${pre}${ebur128MeasureChain(metadataPath)}[a]`].join(';'),
        '-map',
        '[a]',
        '-vn',
        '-f',
        'null',
        '-',
      ],
    };
  };

  const render = (loudnorm: LoudnormPlan, opts: FinalizeRenderOptions = {}): FinalizeRender => {
    const p = encodeProfileFor(input.channel, frame, { bitrateFactor: opts.bitrateFactor });
    const video = [`fps=${p.fps}`];
    if (layout) for (const cue of cues) video.push(buildTimedDrawtext(cue, layout.style));
    if (p.width !== input.width || p.height !== input.height) {
      video.push(`scale=${p.width}:${p.height}:flags=lanczos`);
    }
    video.push('setsar=1', 'format=yuv420p');
    const graph = [
      `[0:v]${video.join(',')}[v]`,
      ...chains,
      `[mix]${[...loudnorm.filters, 'aresample=48000'].join(',')}[a]`,
    ];
    return {
      profile: p,
      args: [
        ...inputArgs(input),
        '-filter_complex',
        graph.join(';'),
        '-map',
        '[v]',
        '-map',
        '[a]',
        ...encodeArgsFor(p),
        input.output,
      ],
    };
  };

  return {
    output: input.output,
    durationMs: input.durationMs,
    profile,
    captions: { count: cues.length, layout },
    ducking: duck,
    measure,
    render,
    verify: { metadataPath: verifyPath, args: buildLoudnessProbeArgs(input.output, verifyPath) },
  };
}
