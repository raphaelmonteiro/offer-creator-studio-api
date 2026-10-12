import {
  ASSEMBLY_FPS,
  buildConcatArgs,
  buildEndcardArgs,
  ENDCARD_DURATION_S,
} from './mc-assembly-graph';
import { buildSpeechTimeline, MC_TALK_GAP_MS } from './mc-talk-conform-graph';
import {
  artBoxToOutputWindow,
  containFitRect,
  windowPxToFractions,
  windowToPixels,
  WindowPx,
} from './mc-talking-art-window';
import { McCharacterWindow, McLogoBox, McProjectFormat } from './mc-types';

/**
 * Grafo de composição do formato "arte que fala" (F1 — change video-formatos-
 * personagem, D3/D7/D12; tarefa 4.4) — funções PURAS que planejam os passes do
 * ffmpeg; o `McComposeFfmpegProcessor` só executa via FfmpegRunner.
 *
 * `buildComposeGraph(input, tempDir)` é o único ponto de entrada do processor
 * e o snapshot `ComposeGraphInput` é o contrato (campos novos são opcionais).
 *
 * Passe único (`compose`, um `-filter_complex`):
 * - BASE = a arte, imagem parada em loop pela duração das falas (`-loop 1
 *   -framerate 30 -t T`), encaixada INTEIRA no quadro de saída — nunca
 *   recortada (D12): `scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:
 *   (ow-iw)/2:(oh-ih)/2:color=<cor>` ou, com `fill: 'blur'`, a mesma arte
 *   contain-fit sobre uma cópia dela em cover desfocada (padrão split/boxblur/
 *   overlay de `buildLowerThirdBlurChain`). Sem arte: quadro liso da cor.
 * - JANELA = cada clipe conformado (vídeo + TTS) encaixado no tamanho da
 *   janela (contain-fit + pad da cor; o aspecto já é o do tile) e sobreposto
 *   na posição com `overlay=x:y:enable='between(t,a,b)'`, nos instantes da
 *   timeline (`buildSpeechTimeline`: durações medidas + silêncios de
 *   150–250 ms). Entre falas o clipe anterior segura o último quadro durante
 *   o silêncio e o seguinte entra com fade de alfa (crossfade ≤ 200 ms dentro
 *   do silêncio — os instantes das falas não mudam).
 * - MODO ROSTO DO LOGO = a janela é a caixa do logo convertida de frações da
 *   ARTE para pixels do quadro (contain-fit); o clipe é ajustado por LARGURA à
 *   caixa e o excedente vertical vira a mesma cor (o fundo do tile já foi
 *   recolorido para a cor amostrada pelo passo de fala — `talkBackgroundColor`).
 * - ÁUDIO = o TTS de cada clipe (a trilha do clipe conformado É o TTS; o áudio
 *   do fornecedor foi descartado na conformação) atrasado ao seu início
 *   (`adelay` em amostras) e misturado (`amix normalize=0`) sobre silêncio
 *   (`anullsrc`) da duração total. Nunca `-shortest`.
 *
 * Cartela opcional: `buildEndcardArgs` + concat por demuxer. Legendas NÃO são
 * queimadas aqui (o `finalize` faz).
 */

/** Versão do grafo de composição: entra no hash do compose_ffmpeg. 2 = arte + janela (4.4). */
export const MC_COMPOSE_GRAPH_VERSION = 2;

/** Crossfade máximo entre falas consecutivas (D7: ≤ 200 ms, dentro do silêncio). */
export const MC_COMPOSE_CROSSFADE_MAX_S = 0.2;

/**
 * CRF do composto: intermediário de alta qualidade (o finalize re-encoda) —
 * margem para o PSNR de luma ≥ 40 dB da arte depois das duas gerações.
 */
export const MC_COMPOSE_CRF = 16;

export type McArtFill = 'color' | 'blur';

export interface ComposeClipInput {
  sceneId: string;
  /** Caminho absoluto do clipe conformado (vídeo + TTS da fala). */
  path: string;
  /** Instantes na timeline composta (s), derivados de `buildSpeechTimeline`. */
  startS: number;
  endS: number;
}

/** Snapshot de entrada do compose (gravado no step e no asset composto). */
export interface ComposeGraphInput {
  format: McProjectFormat;
  aspectRatio: string;
  width: number;
  height: number;
  /** Caminho absoluto da arte de fundo (PNG/JPEG); null = quadro liso da cor. */
  backgroundArtPath: string | null;
  /** Dimensões da arte (px) — base do retângulo contain-fit (modo rosto do logo). */
  artWidth?: number | null;
  artHeight?: number | null;
  /** Janela do personagem em frações do quadro de saída. */
  window: McCharacterWindow;
  logoFace: boolean;
  /** Caixa do logo em frações da ARTE (D9b) — janela do modo rosto do logo. */
  logoBox?: McLogoBox | null;
  /** Cor da janela (#RRGGBB) — fundo do tile, excedente do clipe e preenchimento. */
  backgroundColor: string;
  /** Preenchimento em volta da arte: cor (default) ou a própria arte desfocada. */
  fill?: McArtFill;
  clips: ComposeClipInput[];
  gapMs: number;
  captionsEnabled: boolean;
  endcard: { storeName: string } | null;
}

export interface ComposePass {
  /** Rótulo curto para log/progresso (`compose`, `endcard`, `concat`). */
  label: string;
  args: string[];
  /** Duração do output do passe (ms) — base do progresso do runner. */
  durationMs: number;
  output: string;
}

export interface ComposeGraphPlan {
  passes: ComposePass[];
  /** Arquivos a concatenar, na ordem (falas + cartela); vazio sem cartela. */
  concatInputs: string[];
  /** Caminho da lista do concat (o processor grava o conteúdo antes do passe `concat`). */
  concatListPath: string;
  /** Saída final do grafo. */
  output: string;
  /** Duração esperada do composto (ms): falas + silêncios (+ cartela). */
  expectedDurationMs: number;
  /** Janela efetiva em pixels do quadro (modo rosto do logo já convertido). */
  windowPx: WindowPx;
  /** Retângulo da arte encaixada no quadro; null sem arte. */
  artRect: WindowPx | null;
}

/** Cor de preenchimento para o ffmpeg (`0xRRGGBB`), a partir de `#RRGGBB(AA)`. */
export function ffmpegColor(hex: string): string {
  const clean = (hex ?? '').trim().replace(/^#/, '').slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(clean) ? `0x${clean.toUpperCase()}` : '0xFFFFFF';
}

/**
 * Timeline das falas a partir dos clipes conformados (duração MEDIDA de cada
 * um): instantes = soma das durações anteriores + silêncios (D7).
 */
export function composeTimeline(
  clips: Array<{ sceneId: string; durationMs: number }>,
  gapMs: number = MC_TALK_GAP_MS,
): { clips: Array<{ sceneId: string; startS: number; endS: number }>; totalS: number } {
  const { entries, totalMs } = buildSpeechTimeline(clips, gapMs);
  return {
    clips: entries.map((e) => ({
      sceneId: e.sceneId,
      startS: Number((e.startMs / 1000).toFixed(3)),
      endS: Number((e.endMs / 1000).toFixed(3)),
    })),
    totalS: Number((totalMs / 1000).toFixed(3)),
  };
}

const fmt = (n: number) => Number(n.toFixed(3)).toString();

/**
 * Janela efetiva em pixels: no modo rosto do logo com caixa e dimensões da
 * arte, a caixa (frações da ARTE) passa pelo retângulo contain-fit; senão a
 * janela do roteiro (frações do QUADRO). Sempre dentro do quadro.
 */
export function resolveWindowPx(input: ComposeGraphInput): WindowPx {
  const artW = input.artWidth && input.artWidth > 0 ? input.artWidth : input.width;
  const artH = input.artHeight && input.artHeight > 0 ? input.artHeight : input.height;
  const raw =
    input.logoFace && input.logoBox
      ? artBoxToOutputWindow(input.logoBox, artW, artH, input.width, input.height)
      : windowToPixels(input.window, input.width, input.height);
  const width = Math.min(raw.width, input.width - (input.width % 2));
  const height = Math.min(raw.height, input.height - (input.height % 2));
  return {
    x: Math.max(0, Math.min(raw.x, input.width - width)),
    y: Math.max(0, Math.min(raw.y, input.height - height)),
    width,
    height,
  };
}

/**
 * Janela RESOLVIDA em frações do quadro de saída — o que entra no hash do
 * compose (materializer) e no snapshot: no modo rosto do logo, a caixa do
 * projeto (frações da ARTE) mapeada pelo contain-fit; senão a janela do
 * roteiro. Mover a caixa (PUT logo-box) muda o hash e refaz a composição.
 */
export function composeHashWindow(input: {
  window: McCharacterWindow | null | undefined;
  logoFace: boolean;
  logoBox: McLogoBox | null | undefined;
  artWidth: number | null | undefined;
  artHeight: number | null | undefined;
  width: number;
  height: number;
}): McCharacterWindow | null {
  if (input.logoFace && input.logoBox) {
    const artW = input.artWidth && input.artWidth > 0 ? input.artWidth : input.width;
    const artH = input.artHeight && input.artHeight > 0 ? input.artHeight : input.height;
    const px = artBoxToOutputWindow(input.logoBox, artW, artH, input.width, input.height);
    return windowPxToFractions(px, input.width, input.height);
  }
  return input.window
    ? { x: input.window.x, y: input.window.y, w: input.window.w, h: input.window.h }
    : null;
}

/** Retângulo da arte no quadro; sem dimensões conhecidas assume a arte no aspecto do quadro. */
export function resolveArtRect(input: ComposeGraphInput): WindowPx | null {
  if (!input.backgroundArtPath) return null;
  const artW = input.artWidth ?? null;
  const artH = input.artHeight ?? null;
  if (artW && artH && artW > 0 && artH > 0) {
    return containFitRect(artW, artH, input.width, input.height);
  }
  return { x: 0, y: 0, width: input.width, height: input.height };
}

/** Cadeia da BASE (arte contain-fit com cor ou desfoque; ou quadro liso) → `[base]`. */
export function buildArtBaseChain(input: ComposeGraphInput): string {
  const { width: W, height: H } = input;
  const color = ffmpegColor(input.backgroundColor);
  const tail = `setsar=1,fps=${ASSEMBLY_FPS},format=yuv420p[base]`;
  if (!input.backgroundArtPath) return `[0:v]${tail}`;
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease`;
  if (input.fill === 'blur') {
    // fundo: a arte em cover num quadro reduzido, desfocada e ampliada (barato
    // por quadro); frente: a arte INTEIRA contain-fit no centro.
    const bw = Math.max(2, Math.round(W / 8 / 2) * 2);
    const bh = Math.max(2, Math.round(H / 8 / 2) * 2);
    return (
      `[0:v]split=2[artbg][artfg];` +
      `[artbg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `boxblur=6:2,scale=${W}:${H},setsar=1[blurbg];` +
      `[artfg]${fit}[artfit];` +
      `[blurbg][artfit]overlay=(W-w)/2:(H-h)/2,${tail}`
    );
  }
  return `[0:v]${fit},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${color},${tail}`;
}

interface ClipSlot {
  index: number;
  durationS: number;
  startS: number;
  endS: number;
  /** Quadro inicial clonado antes do início (crossfade com a fala anterior). */
  headHoldS: number;
  /** Último quadro segurado durante o silêncio seguinte. */
  tailHoldS: number;
  /** Fade de alfa (s) no começo do head hold; 0 na primeira fala. */
  fadeInS: number;
}

function planSlots(input: ComposeGraphInput): ClipSlot[] {
  const gapS = Math.max(0, input.gapMs / 1000);
  const crossfadeS = Math.min(MC_COMPOSE_CROSSFADE_MAX_S, gapS);
  return input.clips.map((clip, index) => {
    const isFirst = index === 0;
    const isLast = index === input.clips.length - 1;
    const next = input.clips[index + 1];
    const prev = input.clips[index - 1];
    const gapBefore = prev ? Math.max(0, clip.startS - prev.endS) : 0;
    const gapAfter = next ? Math.max(0, next.startS - clip.endS) : 0;
    return {
      index,
      durationS: Math.max(0, clip.endS - clip.startS),
      startS: clip.startS,
      endS: clip.endS,
      headHoldS: isFirst ? 0 : Math.min(gapBefore, crossfadeS),
      tailHoldS: isLast ? 0 : gapAfter,
      fadeInS: isFirst ? 0 : Math.min(gapBefore, crossfadeS),
    };
  });
}

/**
 * Cadeia de um clipe na janela → `[c{k}]`: duração exata da fala, encaixe na
 * janela (contain-fit + pad; no modo rosto do logo, ajuste por largura com o
 * excedente vertical na cor), seguras de quadro no silêncio, deslocamento
 * para o instante da timeline e fade de alfa na entrada.
 */
export function buildClipWindowChain(
  input: ComposeGraphInput,
  slot: ClipSlot,
  windowPx: WindowPx,
): string {
  const { width: ww, height: wh } = windowPx;
  const color = ffmpegColor(input.backgroundColor);
  const fit = input.logoFace
    ? `scale=${ww}:-2,crop=iw:'min(ih,${wh})',pad=${ww}:${wh}:(ow-iw)/2:(oh-ih)/2:color=${color}`
    : `scale=${ww}:${wh}:force_original_aspect_ratio=decrease,` +
      `pad=${ww}:${wh}:(ow-iw)/2:(oh-ih)/2:color=${color}`;
  // 30 fps CFR desde t=0; 100 ms de último quadro clonado ANTES do trim cobrem
  // um vídeo conformado um quadro mais curto que o áudio (a janela nunca pisca a arte).
  const filters: string[] = [
    'setpts=PTS-STARTPTS',
    `fps=${ASSEMBLY_FPS}`,
    'tpad=stop_mode=clone:stop_duration=0.1',
    `trim=duration=${fmt(slot.durationS)}`,
    'setpts=PTS-STARTPTS',
    fit,
    'setsar=1',
    'format=yuva420p',
  ];
  if (slot.headHoldS > 0 || slot.tailHoldS > 0) {
    const parts: string[] = [];
    if (slot.headHoldS > 0) parts.push(`start_mode=clone:start_duration=${fmt(slot.headHoldS)}`);
    if (slot.tailHoldS > 0) parts.push(`stop_mode=clone:stop_duration=${fmt(slot.tailHoldS)}`);
    filters.push(`tpad=${parts.join(':')}`);
  }
  const appearS = slot.startS - slot.headHoldS;
  filters.push(`setpts=PTS-STARTPTS+${fmt(appearS)}/TB`);
  if (slot.fadeInS > 0) {
    filters.push(`fade=t=in:st=${fmt(appearS)}:d=${fmt(slot.fadeInS)}:alpha=1`);
  }
  return `[${slot.index + 1}:v]${filters.join(',')}[c${slot.index}]`;
}

/** Overlay de um clipe na janela, ligado só no intervalo dele (`enable=between`). */
export function buildWindowOverlay(
  inLabel: string,
  slot: ClipSlot,
  windowPx: WindowPx,
  outLabel: string,
): string {
  const a = slot.startS - slot.headHoldS;
  const b = slot.endS + slot.tailHoldS;
  return (
    `[${inLabel}][c${slot.index}]overlay=x=${windowPx.x}:y=${windowPx.y}:eof_action=pass:` +
    `enable='between(t,${fmt(a)},${fmt(b)})'[${outLabel}]`
  );
}

/** Áudio: TTS de cada fala atrasado ao seu início e misturado sobre silêncio (normalize=0) → `[a]`. */
export function buildSpeechAudioChain(input: ComposeGraphInput, slots: ClipSlot[]): string {
  const silenceInput = input.clips.length + 1;
  const parts = slots.map(
    (slot) =>
      `[${slot.index + 1}:a]atrim=duration=${fmt(slot.durationS)},asetpts=PTS-STARTPTS,` +
      `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `adelay=delays=${Math.round(slot.startS * 48000)}S:all=1[s${slot.index}]`,
  );
  const labels = slots.map((s) => `[s${s.index}]`).join('');
  parts.push(
    `[${silenceInput}:a]${labels}amix=inputs=${slots.length + 1}:duration=first:` +
      `dropout_transition=0:normalize=0,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]`,
  );
  return parts.join(';');
}

/** Duração da parte falada (s): fim da última fala na timeline. */
export function spokenDurationS(input: ComposeGraphInput): number {
  return input.clips.length > 0 ? input.clips[input.clips.length - 1].endS : 0;
}

/** Argumentos do passe único de composição (arte + janela + falas). */
export function buildTalkingArtComposeArgs(input: ComposeGraphInput, output: string): string[] {
  const totalS = spokenDurationS(input);
  const T = fmt(totalS);
  const windowPx = resolveWindowPx(input);
  const slots = planSlots(input);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (input.backgroundArtPath) {
    args.push(
      '-loop',
      '1',
      '-framerate',
      String(ASSEMBLY_FPS),
      '-t',
      T,
      '-i',
      input.backgroundArtPath,
    );
  } else {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `color=c=${ffmpegColor(input.backgroundColor)}:s=${input.width}x${input.height}:` +
        `r=${ASSEMBLY_FPS}:d=${T}`,
    );
  }
  for (const clip of input.clips) args.push('-i', clip.path);
  args.push('-f', 'lavfi', '-t', T, '-i', 'anullsrc=r=48000:cl=stereo');

  const graph: string[] = [buildArtBaseChain(input)];
  let current = 'base';
  for (const slot of slots) {
    graph.push(buildClipWindowChain(input, slot, windowPx));
    const out = slot.index === slots.length - 1 ? 'vwin' : `v${slot.index}`;
    graph.push(buildWindowOverlay(current, slot, windowPx, out));
    current = out;
  }
  graph.push(`[${current}]format=yuv420p[v]`);
  graph.push(buildSpeechAudioChain(input, slots));

  args.push(
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-t',
    T,
    '-r',
    String(ASSEMBLY_FPS),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(MC_COMPOSE_CRF),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    output,
  );
  return args;
}

/**
 * Plano completo do compose a partir do snapshot: passe único de composição,
 * cartela opcional e concat (só com cartela). `tempDir` é onde os
 * intermediários nascem; o processor executa os passes na ordem e grava a
 * lista do concat antes do passe `concat`.
 */
export function buildComposeGraph(input: ComposeGraphInput, tempDir: string): ComposeGraphPlan {
  if (input.clips.length === 0) {
    throw new Error('compose_ffmpeg: nenhum clipe falado para compor');
  }
  const speechMs = Math.round(spokenDurationS(input) * 1000);
  const storeName = input.endcard?.storeName?.trim();
  const concatListPath = `${tempDir}/concat.txt`;
  const windowPx = resolveWindowPx(input);
  const artRect = resolveArtRect(input);
  if (!storeName) {
    const output = `${tempDir}/composed.mp4`;
    return {
      passes: [
        {
          label: 'compose',
          args: buildTalkingArtComposeArgs(input, output),
          durationMs: speechMs,
          output,
        },
      ],
      concatInputs: [],
      concatListPath,
      output,
      expectedDurationMs: speechMs,
      windowPx,
      artRect,
    };
  }
  const speechOut = `${tempDir}/speech.mp4`;
  const endcardOut = `${tempDir}/endcard.mp4`;
  const output = `${tempDir}/composed.mp4`;
  const endcardMs = ENDCARD_DURATION_S * 1000;
  return {
    passes: [
      {
        label: 'compose',
        args: buildTalkingArtComposeArgs(input, speechOut),
        durationMs: speechMs,
        output: speechOut,
      },
      {
        label: 'endcard',
        args: buildEndcardArgs({
          output: endcardOut,
          storeName,
          width: input.width,
          height: input.height,
        }),
        durationMs: endcardMs,
        output: endcardOut,
      },
      {
        label: 'concat',
        args: buildConcatArgs(concatListPath, output),
        durationMs: speechMs + endcardMs,
        output,
      },
    ],
    concatInputs: [speechOut, endcardOut],
    concatListPath,
    output,
    expectedDurationMs: speechMs + endcardMs,
    windowPx,
    artRect,
  };
}

/** Tolerância (ms) entre o composto medido e o esperado (jitter de encoder/probe por clipe). */
export const MC_COMPOSE_DURATION_TOLERANCE_MS = 250;

/** Verificação do arquivo composto: vídeo + áudio e duração ≈ falas + silêncios (+ cartela). */
export function composedOutputIssue(
  probe: {
    hasVideo: boolean;
    hasAudio: boolean;
    durationMs: number | null;
    width: number | null;
    height: number | null;
  },
  expected: { durationMs: number; width: number; height: number },
  toleranceMs: number = MC_COMPOSE_DURATION_TOLERANCE_MS,
): string | null {
  if (!probe.hasVideo) return 'composed_without_video';
  if (!probe.hasAudio) return 'composed_without_audio';
  if (probe.width != null && probe.height != null) {
    if (probe.width !== expected.width || probe.height !== expected.height) {
      return 'composed_dimensions_mismatch';
    }
  }
  if (probe.durationMs != null && Math.abs(probe.durationMs - expected.durationMs) > toleranceMs) {
    return 'composed_duration_mismatch';
  }
  return null;
}
