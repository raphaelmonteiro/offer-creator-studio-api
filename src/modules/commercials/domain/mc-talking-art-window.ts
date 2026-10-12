import { McCharacterWindow } from './mc-types';

/**
 * Janela do personagem na arte que fala (F1 — change video-formatos-personagem,
 * D6/D13, spec "Janela do personagem"): geometria PURA em frações 0..1 do
 * quadro de saída, com o aspecto travado ao do tile do kit e a janela inteira
 * dentro da área segura do tamanho. Aqui vivem o default que o diretor grava
 * no roteiro, os presets (cantos + centro inferior), a validação contra a área
 * segura e o aspecto do tile (tarefa 4.7), o aviso de preço coberto (contrato
 * puro) e a conversão fração ↔ pixel que o compositor (4.4) reutiliza.
 */

export interface SafeAreaPx {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Inset uniforme dos tamanhos sem reserva de topo/rodapé (D13). */
export const MC_SAFE_INSET_PX = 65;

/**
 * Área segura por tamanho (D13): 1080×1920 (Reels e Status) x 65–1015 e
 * y 269–1248; os demais, 65 px em todos os lados. Faixas de preenchimento não
 * ampliam a área: ela depende SÓ do tamanho de saída, nunca da arte.
 */
export function safeAreaFor(width: number, height: number): SafeAreaPx {
  if (width === 1080 && height === 1920) return { left: 65, top: 269, right: 1015, bottom: 1248 };
  return {
    left: MC_SAFE_INSET_PX,
    top: MC_SAFE_INSET_PX,
    right: width - MC_SAFE_INSET_PX,
    bottom: height - MC_SAFE_INSET_PX,
  };
}

/** Proporção do tile quando o kit não informa dimensões (tile mock 720×960). */
export const MC_DEFAULT_TILE_RATIO = 0.75;

/** Altura padrão da janela como fração da altura da área segura (preset "canto inferior direito"). */
export const MC_DEFAULT_WINDOW_HEIGHT_FRACTION = 0.42;

/** Tolerância relativa entre o aspecto da janela (em px) e o do tile (spec: travado, ±2%). */
export const MC_WINDOW_ASPECT_TOLERANCE = 0.02;

/** Folga (px) da checagem de área segura: absorve o arredondamento das frações a 4 casas. */
export const MC_WINDOW_SAFE_TOLERANCE_PX = 1;

const round4 = (n: number) => Number(n.toFixed(4));

/** Razão largura/altura do tile; dimensões ausentes/ inválidas → default 3:4. */
export function tileRatioOf(
  tileWidth: number | null | undefined,
  tileHeight: number | null | undefined,
): number {
  return tileWidth && tileHeight && tileWidth > 0 && tileHeight > 0
    ? tileWidth / tileHeight
    : MC_DEFAULT_TILE_RATIO;
}

export interface DefaultWindowInput {
  width: number;
  height: number;
  tileWidth: number | null | undefined;
  tileHeight: number | null | undefined;
}

/**
 * Janela default do F1: canto inferior direito da área segura, aspecto do
 * tile, altura = 42% da altura da área segura (limitada pela largura). É o que
 * o diretor grava quando o usuário ainda não escolheu preset nem arrastou.
 */
export function defaultCharacterWindow(input: DefaultWindowInput): McCharacterWindow {
  return presetWindow('bottom_right', {
    width: input.width,
    height: input.height,
    tileRatio: tileRatioOf(input.tileWidth, input.tileHeight),
  });
}

// ───────────────────────────── presets (4.7) ─────────────────────────────

/** Presets da janela (spec: cantos e centro inferior). */
export const MC_WINDOW_PRESET_IDS = [
  'top_left',
  'top_right',
  'bottom_left',
  'bottom_right',
  'bottom_center',
] as const;
export type McWindowPresetId = (typeof MC_WINDOW_PRESET_IDS)[number];

const PRESET_LABELS: Record<McWindowPresetId, string> = {
  top_left: 'Canto superior esquerdo',
  top_right: 'Canto superior direito',
  bottom_left: 'Canto inferior esquerdo',
  bottom_right: 'Canto inferior direito',
  bottom_center: 'Centro inferior',
};

export interface McWindowPreset {
  id: McWindowPresetId;
  label: string;
  window: McCharacterWindow;
}

interface PresetFrame {
  width: number;
  height: number;
  tileRatio: number;
  /** Altura da janela como fração da altura da área segura (default 0,42). */
  heightFraction?: number;
}

/** Janela de um preset: ancorada na área segura, aspecto do tile, frações a 4 casas. */
function presetWindow(id: McWindowPresetId, frame: PresetFrame): McCharacterWindow {
  const safe = safeAreaFor(frame.width, frame.height);
  const safeW = safe.right - safe.left;
  const safeH = safe.bottom - safe.top;
  const ratio = frame.tileRatio > 0 ? frame.tileRatio : MC_DEFAULT_TILE_RATIO;
  let h = safeH * (frame.heightFraction ?? MC_DEFAULT_WINDOW_HEIGHT_FRACTION);
  let w = h * ratio;
  if (w > safeW) {
    w = safeW;
    h = w / ratio;
  }
  const x =
    id === 'top_left' || id === 'bottom_left'
      ? safe.left
      : id === 'bottom_center'
        ? safe.left + (safeW - w) / 2
        : safe.right - w;
  const y = id === 'top_left' || id === 'top_right' ? safe.top : safe.bottom - h;
  // Arredonda para DENTRO: a borda direita/inferior nunca passa da área segura por arredondamento.
  const fx = Math.ceil((x / frame.width) * 1e4) / 1e4;
  const fy = Math.ceil((y / frame.height) * 1e4) / 1e4;
  const fw = Math.floor((w / frame.width) * 1e4) / 1e4;
  const fh = Math.floor((h / frame.height) * 1e4) / 1e4;
  return { x: round4(fx), y: round4(fy), w: round4(fw), h: round4(fh) };
}

/**
 * Presets VÁLIDOS para o tamanho de saída e o tile (spec "Janela do
 * personagem"): cantos e centro inferior, ancorados na área segura. Cada
 * candidato passa pelo validador — preset que cairia fora da área segura
 * (ex.: na faixa inferior de preenchimento de uma arte 1:1 em 9:16) ou com
 * aspecto fora do tile é OCULTADO, nunca devolvido.
 */
export function listWindowPresets(
  width: number,
  height: number,
  tileRatio: number,
  opts: { heightFraction?: number } = {},
): McWindowPreset[] {
  const ratio = tileRatio > 0 ? tileRatio : MC_DEFAULT_TILE_RATIO;
  return MC_WINDOW_PRESET_IDS.map((id) => ({
    id,
    label: PRESET_LABELS[id],
    window: presetWindow(id, {
      width,
      height,
      tileRatio: ratio,
      heightFraction: opts.heightFraction,
    }),
  })).filter(
    (preset) =>
      validateCharacterWindow({ window: preset.window, width, height, tileRatio: ratio }).length ===
      0,
  );
}

// ───────────────────────────── conversão px ─────────────────────────────

export interface WindowPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fração → pixels do quadro (inteiros pares, para o overlay/scale do ffmpeg). */
export function windowToPixels(window: McCharacterWindow, width: number, height: number): WindowPx {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return {
    x: Math.round(window.x * width),
    y: Math.round(window.y * height),
    width: even(window.w * width),
    height: even(window.h * height),
  };
}

/** Janela bem formada: frações finitas, tamanho > 0 e inteira dentro do quadro (0..1). */
export function isWindowWellFormed(window: unknown): window is McCharacterWindow {
  if (!window || typeof window !== 'object') return false;
  const { x, y, w, h } = window as Record<string, unknown>;
  const nums = [x, y, w, h];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const [fx, fy, fw, fh] = nums as number[];
  return fx >= 0 && fy >= 0 && fw > 0 && fh > 0 && fx + fw <= 1 + 1e-9 && fy + fh <= 1 + 1e-9;
}

/**
 * Retângulo da arte encaixada inteira no quadro (contain-fit: escala
 * `min(W/aw, H/ah)`, centrada, faixas de preenchimento nas sobras), com o
 * mesmo arredondamento do ffmpeg: `scale=W:H:force_original_aspect_ratio=
 * decrease` (av_rescale → inteiro mais próximo) + `pad=(ow-iw)/2:(oh-ih)/2`
 * (deslocamento truncado; o pad roda em RGB para PNG — medido: 1280×928 →
 * 1920×1080 começa em x 215). Arte JPEG pode ter o pad em yuv420p e cair 1 px
 * para a esquerda/cima (par) — irrelevante para a janela. Base do modo rosto
 * do logo (caixa em frações da ARTE → pixels do quadro) e das máscaras de PSNR.
 */
export function containFitRect(
  srcWidth: number,
  srcHeight: number,
  width: number,
  height: number,
): WindowPx {
  if (!(srcWidth > 0 && srcHeight > 0)) return { x: 0, y: 0, width, height };
  const scaledW = Math.min(width, Math.round((height * srcWidth) / srcHeight));
  const scaledH = Math.min(height, Math.round((width * srcHeight) / srcWidth));
  return {
    x: Math.floor((width - scaledW) / 2),
    y: Math.floor((height - scaledH) / 2),
    width: scaledW,
    height: scaledH,
  };
}

/**
 * Modo rosto do logo (spec "Modo rosto do logo"): a caixa do logo vem em
 * FRAÇÕES DA ARTE (`McLogoBox`, D9b) e vira a janela em pixels do quadro de
 * saída através do retângulo da arte encaixada (contain-fit). Tamanho par.
 */
export function logoBoxToWindowPx(
  box: { x: number; y: number; w: number; h: number },
  artRect: WindowPx,
): WindowPx {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return {
    x: Math.round(artRect.x + box.x * artRect.width),
    y: Math.round(artRect.y + box.y * artRect.height),
    width: even(box.w * artRect.width),
    height: even(box.h * artRect.height),
  };
}

/**
 * Caixa em frações da ARTE (ex.: `project.logoBox`) → janela em PIXELS do
 * quadro de saída, pela mesma transformação contain-fit da base do compose:
 * arte 1080×1350 em 1080×1920 desce 285 px (faixa superior); 1280×928 em
 * 1920×1080 anda 215 px (faixa lateral) e escala 1080/928.
 */
export function artBoxToOutputWindow(
  box: { x: number; y: number; w: number; h: number },
  artWidth: number,
  artHeight: number,
  outWidth: number,
  outHeight: number,
): WindowPx {
  return logoBoxToWindowPx(box, containFitRect(artWidth, artHeight, outWidth, outHeight));
}

/** Janela em pixels → frações do quadro (4 casas) — forma do roteiro, da prévia e do hash. */
export function windowPxToFractions(
  px: WindowPx,
  width: number,
  height: number,
): McCharacterWindow {
  return {
    x: round4(px.x / width),
    y: round4(px.y / height),
    w: round4(px.width / width),
    h: round4(px.height / height),
  };
}

// ───────────────────────────── validação (4.7) ─────────────────────────────

export type McWindowIssueCode = 'WINDOW_OUTSIDE_SAFE_AREA' | 'WINDOW_ASPECT_MISMATCH';

export interface McWindowIssue {
  code: McWindowIssueCode;
  /** Elemento recusado (spec: "a validação recusa ... apontando o elemento"). */
  element: 'character_window';
  message: string;
  details: Record<string, unknown>;
}

export interface ValidateWindowInput {
  window: McCharacterWindow;
  width: number;
  height: number;
  /** Razão largura/altura do tile do kit; ausente = sem checagem de aspecto. */
  tileRatio?: number | null;
  /**
   * Modo rosto do logo: a janela é a caixa do logo, ditada pela própria arte
   * (que a spec isenta da área segura) e ajustada por largura — nem a área
   * segura nem o aspecto do tile se aplicam.
   */
  logoFace?: boolean;
}

/**
 * Validação da janela do personagem contra a área segura do tamanho de saída
 * e o aspecto do tile (spec "Janela do personagem" / "Tamanhos e áreas
 * seguras"). Devolve os problemas apontando o elemento e as bordas que
 * vazam — lista vazia = janela aceita. A área segura depende só do tamanho:
 * faixas de preenchimento da arte nunca a ampliam.
 */
export function validateCharacterWindow(input: ValidateWindowInput): McWindowIssue[] {
  if (input.logoFace) return [];
  const issues: McWindowIssue[] = [];
  const { window, width, height } = input;
  const safe = safeAreaFor(width, height);
  const px = {
    left: window.x * width,
    top: window.y * height,
    right: (window.x + window.w) * width,
    bottom: (window.y + window.h) * height,
  };
  const tol = MC_WINDOW_SAFE_TOLERANCE_PX;
  const edges: Array<'left' | 'top' | 'right' | 'bottom'> = [];
  if (px.left < safe.left - tol) edges.push('left');
  if (px.top < safe.top - tol) edges.push('top');
  if (px.right > safe.right + tol) edges.push('right');
  if (px.bottom > safe.bottom + tol) edges.push('bottom');
  if (edges.length > 0) {
    issues.push({
      code: 'WINDOW_OUTSIDE_SAFE_AREA',
      element: 'character_window',
      message:
        `A janela do personagem sai da área segura de ${width}×${height} ` +
        `(x ${safe.left}–${safe.right}, y ${safe.top}–${safe.bottom}) pela borda ` +
        `${edges.map((e) => EDGE_LABELS[e]).join(', ')}.`,
      details: {
        edges,
        safeArea: safe,
        windowPx: {
          left: Math.round(px.left),
          top: Math.round(px.top),
          right: Math.round(px.right),
          bottom: Math.round(px.bottom),
        },
      },
    });
  }
  const tileRatio = input.tileRatio;
  if (tileRatio && tileRatio > 0 && window.h > 0) {
    const windowRatio = (window.w * width) / (window.h * height);
    const deviation = Math.abs(windowRatio - tileRatio) / tileRatio;
    if (deviation > MC_WINDOW_ASPECT_TOLERANCE) {
      issues.push({
        code: 'WINDOW_ASPECT_MISMATCH',
        element: 'character_window',
        message:
          `A janela do personagem precisa manter o aspecto do tile ` +
          `(${tileRatio.toFixed(3)}, tolerância de 2%); a janela tem ${windowRatio.toFixed(3)}.`,
        details: {
          windowRatio: Number(windowRatio.toFixed(4)),
          tileRatio: Number(tileRatio.toFixed(4)),
        },
      });
    }
  }
  return issues;
}

const EDGE_LABELS: Record<'left' | 'top' | 'right' | 'bottom', string> = {
  left: 'esquerda',
  top: 'superior',
  right: 'direita',
  bottom: 'inferior',
};

// ─────────────────────── aviso de preço coberto (4.7) ───────────────────────

/** Texto detectado na arte (Gemini visão), com a caixa em frações do QUADRO DE SAÍDA. */
export interface McArtTextDetection {
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  /** `price` quando o detector já classificou; senão o texto decide. */
  kind?: 'price' | 'text';
  confidence?: number;
}

export interface McWindowPriceWarning {
  code: 'WINDOW_COVERS_PRICE';
  message: string;
  covered: McArtTextDetection[];
  /** Presets (da lista dada) que não cobrem nenhum preço — sugestão da UI. */
  suggestedPresetIds: McWindowPresetId[];
}

/** Fração mínima da caixa do preço coberta pela janela para avisar. */
export const MC_PRICE_COVER_MIN_FRACTION = 0.2;
/** Confiança mínima da detecção para entrar no aviso. */
export const MC_PRICE_DETECTION_MIN_CONFIDENCE = 0.5;

const PRICE_TEXT = /(R\$\s*\d)|(\d+,\d{2}\b)/i;

function isPriceDetection(d: McArtTextDetection): boolean {
  if ((d.confidence ?? 1) < MC_PRICE_DETECTION_MIN_CONFIDENCE) return false;
  return d.kind === 'price' || PRICE_TEXT.test(d.text ?? '');
}

function coveredFraction(
  box: { x: number; y: number; w: number; h: number },
  window: McCharacterWindow,
): number {
  const ix = Math.max(0, Math.min(box.x + box.w, window.x + window.w) - Math.max(box.x, window.x));
  const iy = Math.max(0, Math.min(box.y + box.h, window.y + window.h) - Math.max(box.y, window.y));
  const area = box.w * box.h;
  return area > 0 ? (ix * iy) / area : 0;
}

/**
 * Aviso "janela sobre preço" (spec "Janela sobre preço") — CONTRATO PURO: as
 * detecções de texto da arte (Gemini visão sobre a região, frações do quadro
 * de saída) entram prontas; preço coberto em ≥ 20% da caixa gera o aviso com
 * os presets alternativos que não cobrem preço. Não bloqueia.
 *
 * Detecção: `McWindowPriceService` (Gemini visão sobre a arte de fundo, cache
 * por arte no `metadata.priceDetections`) converte as caixas da arte para
 * frações do quadro de saída (`detectionsToOutputFrame`) antes de chamar esta
 * função — exposta em `GET /commercials/projects/:id/window-warnings`.
 */
export function windowCoversPriceWarning(
  detections: McArtTextDetection[],
  window: McCharacterWindow,
  presets: McWindowPreset[] = [],
): McWindowPriceWarning | null {
  const prices = (detections ?? []).filter(isPriceDetection);
  const covered = prices.filter(
    (d) => coveredFraction(d.bbox, window) >= MC_PRICE_COVER_MIN_FRACTION,
  );
  if (covered.length === 0) return null;
  const suggestedPresetIds = presets
    .filter((p) =>
      prices.every((d) => coveredFraction(d.bbox, p.window) < MC_PRICE_COVER_MIN_FRACTION),
    )
    .map((p) => p.id);
  return {
    code: 'WINDOW_COVERS_PRICE',
    message:
      covered.length === 1
        ? 'A janela do personagem cobre um preço da arte. Escolha outra posição.'
        : `A janela do personagem cobre ${covered.length} preços da arte. Escolha outra posição.`,
    covered,
    suggestedPresetIds,
  };
}
