import { computeInputHash, MC_BUILDER_VERSIONS_V2 } from './input-hash';
import { alignmentToWords, ElevenLabsAlignment } from './mc-captions';
import { compositionDimensions } from './mc-composition.config';
import { parsePreco } from './mc-preco-extenso';
import { McCarouselRendererKind } from './mc-render.config';
import { buildSpeechTimeline, MC_TALK_GAP_MS } from './mc-talk-conform-graph';
import { safeAreaFor, SafeAreaPx } from './mc-talking-art-window';
import {
  isCarouselLayoutPreset,
  McAspectRatio,
  MC_DEFAULT_CAROUSEL_LAYOUT_PRESET,
  McCarouselLayoutPreset,
  McCarouselLine,
  McCarouselLineKind,
  McScript,
  McSealProduct,
  McStepType,
} from './mc-types';

/**
 * Props da composição Remotion `OfferCarousel` (F2 "ofertas em sequência" —
 * change video-formatos-personagem, tarefa 6.5; design D3/D3b/D7/D8) —
 * funções PURAS. O pacote `@chroma/video-templates` NÃO é dependência do
 * backend: o contrato das props é espelhado aqui (tipos + `presetLayout` /
 * `presetFractions` portados de `src/core/layout.ts` 0.1.0) e o worker o
 * revalida com `parseOfferCarouselProps`/`validateLayout` do pacote quando ele
 * está instalado (RemotionCarouselRenderer).
 *
 * Contrato (pacote 0.1.0): tempos ABSOLUTOS em segundos na timeline da
 * composição; preço "24,90" sem "R$"; mídia por URL absoluta http(s); tamanhos
 * 1080×1920 · 1080×1350 · 1080×1080 · 1920×1080; 3 a 6 ofertas; falas =
 * abertura, uma por oferta NA ORDEM das ofertas e fechamento; palavras dentro
 * da janela da fala; clipes em ordem e sem sobreposição.
 *
 * A timeline é a mesma do F1 (`buildSpeechTimeline`: durações MEDIDAS dos
 * clipes conformados + silêncios de 200 ms); as palavras vêm do alinhamento
 * por caractere do TTS de cada fala, deslocadas para o início dela.
 */

// ───────────────────────── espelho do contrato de props ─────────────────────────

export interface OfferCarouselFractionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OfferCarouselWordProps {
  text: string;
  startS: number;
  endS: number;
}

export interface OfferCarouselLineProps {
  id: string;
  kind: McCarouselLineKind;
  offerId?: string;
  startS: number;
  endS: number;
  words: OfferCarouselWordProps[];
}

export interface OfferCarouselOfferProps {
  id: string;
  name: string;
  price: string;
  originalPrice?: string;
  unit?: string;
  badge?: string;
  imageUrl: string;
  catalogId?: string | null;
}

export interface OfferCarouselClipProps {
  src: string;
  startS: number;
  endS: number;
  lineId?: string;
}

export interface OfferCarouselCharacterProps {
  clips: OfferCarouselClipProps[];
  window: OfferCarouselFractionRect;
  tileRatio: number;
  posterUrl?: string;
  backgroundColor?: string;
}

export interface OfferCarouselBrandProps {
  logoUrl?: string;
  name?: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  fontUrl?: string;
}

export interface OfferCarouselMusicProps {
  src: string;
  volume: number;
  duck?: boolean;
}

/** Props da composição — `type` (não interface): o Remotion exige Record<string, unknown>. */
export type OfferCarouselProps = {
  width: number;
  height: number;
  fps: 30;
  character: OfferCarouselCharacterProps;
  offers: OfferCarouselOfferProps[];
  lines: OfferCarouselLineProps[];
  brand: OfferCarouselBrandProps;
  layoutPreset: McCarouselLayoutPreset;
  captions: boolean;
  music?: OfferCarouselMusicProps;
  cardBox?: OfferCarouselFractionRect;
};

// ───────────────────────── tokens/geometria (port do pacote) ─────────────────────────

export const MC_CAROUSEL_FPS = 30 as const;

/**
 * Tokens de layout e tempo da composição 0.1.0 (`src/core/tokens.ts`) que a
 * geometria e a duração dependem. Mudou no pacote → bump de
 * `MC_COMPOSITION_VERSION` (o hash do render muda junto).
 */
export const MC_CAROUSEL_TOKENS = {
  gap: 24,
  sideCharacterWidthFraction: 0.4,
  bottomCharacterHeightFraction: 0.42,
  captionBandPortrait: 150,
  captionBandLandscape: 140,
  cardMaxHeightRatio: 1.45,
  cardMaxWidthRatio: 2.6,
  cardMinWidth: 280,
  cardMinHeight: 240,
  safeAreaTolerancePx: 1,
  windowAspectTolerance: 0.02,
  /** Cartela final: logo depois do fim da última fala (s). */
  endcardPaddingS: 1.5,
  /** Transição de entrada do card: termina na primeira palavra (≤ 0,5 s antes). */
  cardEntryS: 0.45,
} as const;

/** Cores/fonte da marca quando o projeto não define (o cliente ainda não tem paleta cadastrada). */
export const MC_CAROUSEL_BRAND_DEFAULTS = {
  primaryColor: '#C62828',
  secondaryColor: '#FFD54F',
  fontFamily: 'DejaVu Sans',
} as const;

export interface CarouselPxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CarouselPresetLayout {
  safe: SafeAreaPx;
  character: CarouselPxRect;
  card: CarouselPxRect;
  captions: CarouselPxRect | null;
}

const round4 = (n: number) => Number(n.toFixed(4));

function captionBandHeight(width: number, height: number): number {
  return height >= width
    ? MC_CAROUSEL_TOKENS.captionBandPortrait
    : MC_CAROUSEL_TOKENS.captionBandLandscape;
}

function fitCardInRegion(region: CarouselPxRect): CarouselPxRect {
  let { width, height } = region;
  if (height > width * MC_CAROUSEL_TOKENS.cardMaxHeightRatio) {
    height = Math.floor(width * MC_CAROUSEL_TOKENS.cardMaxHeightRatio);
  }
  if (width > height * MC_CAROUSEL_TOKENS.cardMaxWidthRatio) {
    width = Math.floor(height * MC_CAROUSEL_TOKENS.cardMaxWidthRatio);
  }
  return {
    x: region.x + Math.floor((region.width - width) / 2),
    y: region.y + Math.floor((region.height - height) / 2),
    width,
    height,
  };
}

/**
 * Regiões do preset em PIXELS (port fiel de `presetLayout` do pacote 0.1.0):
 * faixa de legendas no topo da área segura (com legendas), personagem numa
 * coluna lateral ancorada embaixo (ou centrado embaixo) no aspecto do tile e
 * cards no resto, sem sobreposição.
 */
export function carouselPresetLayout(input: {
  width: number;
  height: number;
  tileRatio: number;
  preset: McCarouselLayoutPreset;
  captions: boolean;
}): CarouselPresetLayout {
  const { width, height, preset, captions } = input;
  const ratio = input.tileRatio > 0 ? input.tileRatio : 0.75;
  const gap = MC_CAROUSEL_TOKENS.gap;
  const safe = safeAreaFor(width, height);
  const safeW = safe.right - safe.left;
  const band = captions ? captionBandHeight(width, height) : 0;
  const captionsRect: CarouselPxRect | null = captions
    ? { x: safe.left, y: safe.top, width: safeW, height: band }
    : null;
  const contentTop = safe.top + (captions ? band + gap : 0);
  const contentH = safe.bottom - contentTop;

  if (preset === 'character_bottom') {
    let charH = Math.floor(contentH * MC_CAROUSEL_TOKENS.bottomCharacterHeightFraction);
    let charW = Math.floor(charH * ratio);
    if (charW > safeW) {
      charW = safeW;
      charH = Math.floor(charW / ratio);
    }
    const character: CarouselPxRect = {
      x: safe.left + Math.floor((safeW - charW) / 2),
      y: safe.bottom - charH,
      width: charW,
      height: charH,
    };
    const card = fitCardInRegion({
      x: safe.left,
      y: contentTop,
      width: safeW,
      height: character.y - gap - contentTop,
    });
    return { safe, character, card, captions: captionsRect };
  }

  let charW = Math.floor(
    Math.min(safeW * MC_CAROUSEL_TOKENS.sideCharacterWidthFraction, contentH * ratio),
  );
  const charH = Math.floor(charW / ratio);
  if (charH > contentH) charW = Math.floor(contentH * ratio);
  const character: CarouselPxRect = {
    x: preset === 'character_left' ? safe.left : safe.right - charW,
    y: safe.bottom - Math.floor(charW / ratio),
    width: charW,
    height: Math.floor(charW / ratio),
  };
  const cardRegion: CarouselPxRect = {
    x: preset === 'character_left' ? safe.left + charW + gap : safe.left,
    y: contentTop,
    width: safeW - charW - gap,
    height: contentH,
  };
  return { safe, character, card: fitCardInRegion(cardRegion), captions: captionsRect };
}

/** Pixels → frações arredondadas PARA DENTRO (port de `pxToFractionRect`). */
export function carouselPxToFractions(
  rect: CarouselPxRect,
  width: number,
  height: number,
): OfferCarouselFractionRect {
  const x = Math.ceil((rect.x / width) * 1e4) / 1e4;
  const y = Math.ceil((rect.y / height) * 1e4) / 1e4;
  const right = Math.floor(((rect.x + rect.width) / width) * 1e4) / 1e4;
  const bottom = Math.floor(((rect.y + rect.height) / height) * 1e4) / 1e4;
  return { x: round4(x), y: round4(y), w: round4(right - x), h: round4(bottom - y) };
}

/** Frações → pixels inteiros do quadro (port de `fractionRectToPx`). */
export function carouselFractionsToPx(
  rect: OfferCarouselFractionRect,
  width: number,
  height: number,
): CarouselPxRect {
  const x = Math.round(rect.x * width);
  const y = Math.round(rect.y * height);
  return {
    x,
    y,
    width: Math.round((rect.x + rect.w) * width) - x,
    height: Math.round((rect.y + rect.h) * height) - y,
  };
}

/** Janela do personagem e caixa dos cards do preset, em frações (port de `presetFractions`). */
export function carouselPresetFractions(input: Parameters<typeof carouselPresetLayout>[0]): {
  window: OfferCarouselFractionRect;
  cardBox: OfferCarouselFractionRect;
  captions: OfferCarouselFractionRect | null;
} {
  const px = carouselPresetLayout(input);
  return {
    window: carouselPxToFractions(px.character, input.width, input.height),
    cardBox: carouselPxToFractions(px.card, input.width, input.height),
    captions: px.captions ? carouselPxToFractions(px.captions, input.width, input.height) : null,
  };
}

/** Preset do F2: o do roteiro, senão o do projeto (ponte), senão `character_left`. */
export function carouselLayoutPresetOf(
  script: Pick<McScript, 'layoutPreset'> | null | undefined,
  project: { layoutPreset?: string | null },
): McCarouselLayoutPreset {
  if (isCarouselLayoutPreset(script?.layoutPreset)) return script.layoutPreset;
  if (isCarouselLayoutPreset(project.layoutPreset)) return project.layoutPreset;
  return MC_DEFAULT_CAROUSEL_LAYOUT_PRESET;
}

/** Legendas do F2: as do roteiro (`captions`), senão a opção do projeto. */
export function carouselCaptionsOf(
  script: Pick<McScript, 'captions'> | null | undefined,
  options: { captionsEnabled: boolean },
): boolean {
  return typeof script?.captions === 'boolean' ? script.captions : options.captionsEnabled;
}

// ───────────────────────── normalização de dados ─────────────────────────

/** Formato de preço do contrato: "24,90" / "1.299,00" (sem "R$"). */
export const MC_CAROUSEL_PRICE_PATTERN = /^(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}$/;

/**
 * Preço congelado → contrato ("24,90"): mantém o texto quando já casa;
 * "R$ 8,9" / "8" / "1299,9" são reformatados SEM aritmética de ponto
 * flutuante (reais e centavos inteiros). Ilegível → null.
 */
export function carouselPrice(price: string | null | undefined): string | null {
  const text = (price ?? '')
    .trim()
    .replace(/^R\$\s*/i, '')
    .trim();
  if (!text) return null;
  if (MC_CAROUSEL_PRICE_PATTERN.test(text)) return text;
  const parsed = parsePreco(text);
  if (!parsed) return null;
  const reais = String(parsed.reais).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${reais},${String(parsed.centavos).padStart(2, '0')}`;
}

/** URL de mídia absoluta para o navegador do render: `/uploads/x` → `<base>/uploads/x`. */
export function absoluteAssetUrl(url: string, baseUrl: string): string {
  const trimmed = (url ?? '').trim();
  if (/^(?:https?:|data:)/i.test(trimmed)) return trimmed;
  const base = baseUrl.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? `${base}${trimmed}` : `${base}/${trimmed}`;
}

const seconds = (n: number) => Number(Math.max(0, n).toFixed(3));

/** Texto limitado ao tamanho do contrato (sem cortar no meio de nada além do limite duro). */
function clampText(text: string | null | undefined, max: number): string | undefined {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function hexOr(value: string | null | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  return HEX_COLOR.test(v) ? v.toUpperCase() : fallback;
}

/** Erro de MONTAGEM das props (dados do projeto incompatíveis com o contrato) — terminal no processor. */
export class McCarouselPropsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'McCarouselPropsError';
  }
}

// ───────────────────────── montagem das props ─────────────────────────

/** Uma fala do roteiro F2 já produzida: clipe conformado (vídeo + TTS) e o alinhamento do TTS. */
export interface OfferCarouselSpeechInput {
  sceneId: string;
  /** Duração MEDIDA do clipe conformado (= duração do áudio, D7). */
  durationMs: number;
  /** URL do clipe conformado (relativa `/uploads/...` ou absoluta). */
  clipUrl: string;
  alignment: ElevenLabsAlignment | null;
}

export interface OfferCarouselPropsInput {
  aspectRatio: McAspectRatio;
  /** Ofertas congeladas do roteiro, NA ORDEM do vídeo. */
  offers: McSealProduct[];
  /** Falas do roteiro (abertura, uma por oferta, fechamento). */
  lines: McCarouselLine[];
  /** Falas produzidas, na MESMA ordem de `lines` (casadas por `sceneId`). */
  speeches: OfferCarouselSpeechInput[];
  layoutPreset: McCarouselLayoutPreset;
  captions: boolean;
  /** Tile de fala do kit: dimensões (aspecto da janela) e URL (pôster entre falas). */
  tile: { width: number | null; height: number | null; url: string | null };
  /** Cor da janela (#RRGGBB) — a mesma do tile de fala recolorido. */
  characterBackgroundColor: string | null;
  brand: {
    logoUrl?: string | null;
    name?: string | null;
    primaryColor?: string | null;
    secondaryColor?: string | null;
    fontFamily?: string | null;
    fontUrl?: string | null;
  };
  /** Base das URLs absolutas (`MC_RENDER_ASSET_BASE_URL`). */
  assetBaseUrl: string;
  gapMs?: number;
  /** Caixa dos cards ajustada na prévia (frações); ausente = a do preset. */
  cardBox?: OfferCarouselFractionRect | null;
}

export interface OfferCarouselTimeline {
  /** Fim da última fala (s) — a composição acrescenta a cartela (`endcardPaddingS`). */
  speechEndS: number;
  /** Duração do vídeo da composição (s), em quadros inteiros. */
  totalS: number;
  scenes: Array<{ sceneId: string; startS: number; endS: number }>;
}

/** Razão do tile limitada ao intervalo do contrato (0,5–1,5); sem dimensões → 3:4. */
export function carouselTileRatio(width: number | null, height: number | null): number {
  const ratio = width && height && width > 0 && height > 0 ? width / height : 0.75;
  return round4(Math.min(1.5, Math.max(0.5, ratio)));
}

/** Palavras do TTS (s relativos à fala) → absolutas na timeline, presas à janela da fala. */
export function carouselWords(
  alignment: ElevenLabsAlignment | null,
  startS: number,
  endS: number,
): OfferCarouselWordProps[] {
  if (!alignment) return [];
  let words: Array<{ text: string; startS: number; endS: number }>;
  try {
    words = alignmentToWords(alignment);
  } catch {
    return [];
  }
  const out: OfferCarouselWordProps[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const a = seconds(Math.min(endS, startS + Math.max(0, word.startS)));
    const b = seconds(Math.min(endS, Math.max(a, startS + Math.max(0, word.endS))));
    const previous = out[out.length - 1];
    // palavras em ordem (o contrato recusa início anterior ao da palavra de antes)
    const start = previous && a < previous.startS ? previous.startS : a;
    out.push({ text, startS: start, endS: Math.max(b, start) });
  }
  return out;
}

/**
 * Props da composição a partir do roteiro F2 e das falas produzidas. Lança
 * `McCarouselPropsError` quando os dados não cabem no contrato (falas que não
 * casam com o roteiro, oferta sem foto ou com preço ilegível).
 */
export function buildOfferCarouselProps(input: OfferCarouselPropsInput): {
  props: OfferCarouselProps;
  timeline: OfferCarouselTimeline;
} {
  const { width, height } = compositionDimensions(input.aspectRatio);
  if (input.lines.length !== input.speeches.length) {
    throw new McCarouselPropsError(
      'CAROUSEL_SPEECHES_MISMATCH',
      `O roteiro tem ${input.lines.length} falas e há ${input.speeches.length} clipes prontos.`,
      { lines: input.lines.length, speeches: input.speeches.length },
    );
  }
  input.lines.forEach((line, i) => {
    if (input.speeches[i].sceneId !== line.sceneId) {
      throw new McCarouselPropsError(
        'CAROUSEL_SPEECHES_MISMATCH',
        `A fala ${i + 1} do roteiro não corresponde ao clipe ${i + 1}.`,
        { position: i, lineSceneId: line.sceneId, speechSceneId: input.speeches[i].sceneId },
      );
    }
  });

  const base = input.assetBaseUrl;
  const offers: OfferCarouselOfferProps[] = input.offers.map((offer, i) => {
    const price = carouselPrice(offer.price);
    if (!offer.id || !price) {
      throw new McCarouselPropsError(
        'CAROUSEL_OFFER_INVALID',
        `Oferta ${i + 1} ("${offer.name}") sem chave ou com preço ilegível ("${offer.price}").`,
        { offerId: offer.id ?? null, price: offer.price },
      );
    }
    if (!offer.imageUrl?.trim()) {
      throw new McCarouselPropsError(
        'OFFER_IMAGE_REQUIRED',
        `Oferta ${i + 1} ("${offer.name}") sem foto.`,
        { offerId: offer.id },
      );
    }
    const originalPrice = carouselPrice(offer.originalPrice ?? null);
    const unit = clampText(offer.unit, 24);
    const badge = clampText(offer.badge, 24);
    return {
      id: offer.id,
      name: clampText(offer.name, 80) ?? offer.id,
      price,
      ...(originalPrice ? { originalPrice } : {}),
      ...(unit ? { unit } : {}),
      ...(badge ? { badge } : {}),
      imageUrl: absoluteAssetUrl(offer.imageUrl, base),
      catalogId: offer.catalogId ?? null,
    };
  });

  const { entries, totalMs } = buildSpeechTimeline(
    input.speeches.map((s) => ({ sceneId: s.sceneId, durationMs: s.durationMs })),
    input.gapMs ?? MC_TALK_GAP_MS,
  );
  const lines: OfferCarouselLineProps[] = input.lines.map((line, i) => {
    const startS = seconds(entries[i].startMs / 1000);
    const endS = seconds(entries[i].endMs / 1000);
    return {
      id: line.sceneId,
      kind: line.kind,
      ...(line.kind === 'offer' && line.offerRef ? { offerId: line.offerRef } : {}),
      startS,
      endS,
      words: carouselWords(input.speeches[i].alignment, startS, endS),
    };
  });
  const clips: OfferCarouselClipProps[] = input.speeches.map((speech, i) => ({
    src: absoluteAssetUrl(speech.clipUrl, base),
    startS: lines[i].startS,
    endS: lines[i].endS,
    lineId: speech.sceneId,
  }));

  const tileRatio = carouselTileRatio(input.tile.width, input.tile.height);
  const preset = carouselPresetFractions({
    width,
    height,
    tileRatio,
    preset: input.layoutPreset,
    captions: input.captions,
  });
  const characterColor = input.characterBackgroundColor
    ? hexOr(input.characterBackgroundColor, '#FFFFFF')
    : undefined;
  const brandName = clampText(input.brand.name, 60);
  const props: OfferCarouselProps = {
    width,
    height,
    fps: MC_CAROUSEL_FPS,
    character: {
      clips,
      window: preset.window,
      tileRatio,
      ...(input.tile.url ? { posterUrl: absoluteAssetUrl(input.tile.url, base) } : {}),
      ...(characterColor ? { backgroundColor: characterColor } : {}),
    },
    offers,
    lines,
    brand: {
      ...(input.brand.logoUrl ? { logoUrl: absoluteAssetUrl(input.brand.logoUrl, base) } : {}),
      ...(brandName ? { name: brandName } : {}),
      primaryColor: hexOr(input.brand.primaryColor, MC_CAROUSEL_BRAND_DEFAULTS.primaryColor),
      secondaryColor: hexOr(input.brand.secondaryColor, MC_CAROUSEL_BRAND_DEFAULTS.secondaryColor),
      fontFamily: clampText(input.brand.fontFamily, 80) ?? MC_CAROUSEL_BRAND_DEFAULTS.fontFamily,
      ...(input.brand.fontUrl ? { fontUrl: absoluteAssetUrl(input.brand.fontUrl, base) } : {}),
    },
    layoutPreset: input.layoutPreset,
    captions: input.captions,
    ...(input.cardBox ? { cardBox: { ...input.cardBox } } : {}),
  };
  const speechEndS = seconds(totalMs / 1000);
  return {
    props,
    timeline: {
      speechEndS,
      totalS: carouselDurationS(props),
      scenes: lines.map((l) => ({ sceneId: l.id, startS: l.startS, endS: l.endS })),
    },
  };
}

/** Duração da composição (s) = quadros de (fim da última fala/clipe + cartela) — `computeDurationInFrames`. */
export function carouselDurationS(
  props: Pick<OfferCarouselProps, 'lines' | 'character' | 'fps'>,
): number {
  const lineEnd = Math.max(0, ...props.lines.map((l) => l.endS));
  const clipEnd = Math.max(0, ...props.character.clips.map((c) => c.endS));
  const frames = Math.max(
    1,
    Math.ceil((Math.max(lineEnd, clipEnd) + MC_CAROUSEL_TOKENS.endcardPaddingS) * props.fps - 1e-9),
  );
  return Number((frames / props.fps).toFixed(3));
}

// ───────────────────────── validação local (sem o pacote) ─────────────────────────

export interface CarouselLayoutIssue {
  code: string;
  element: 'frame' | 'character_window' | 'card' | 'offers' | 'lines';
  elementId: string | null;
  message: string;
}

function outside(rect: CarouselPxRect, safe: SafeAreaPx, tol: number): boolean {
  return (
    rect.x < safe.left - tol ||
    rect.y < safe.top - tol ||
    rect.x + rect.width > safe.right + tol ||
    rect.y + rect.height > safe.bottom + tol
  );
}

function intersects(a: CarouselPxRect, b: CarouselPxRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Validação LOCAL das props (subconjunto do `parseOfferCarouselProps` +
 * `validateLayout` do pacote): estrutura do roteiro, preços, 3–6 ofertas,
 * janela e cards dentro da área segura e sem sobreposição. O mock usa só esta;
 * o Remotion roda a do pacote também (defesa em profundidade).
 */
export function carouselPropsIssues(props: OfferCarouselProps): CarouselLayoutIssue[] {
  const issues: CarouselLayoutIssue[] = [];
  if (props.offers.length < 3 || props.offers.length > 6) {
    issues.push({
      code: 'OFFERS_COUNT',
      element: 'offers',
      elementId: null,
      message: `A composição pede de 3 a 6 ofertas (recebidas: ${props.offers.length}).`,
    });
  }
  for (const offer of props.offers) {
    if (!MC_CAROUSEL_PRICE_PATTERN.test(offer.price)) {
      issues.push({
        code: 'OFFER_PRICE_FORMAT',
        element: 'offers',
        elementId: offer.id,
        message: `Preço "${offer.price}" fora do formato 24,90.`,
      });
    }
  }
  const kinds = props.lines.map((l) => l.kind);
  const offerLines = props.lines.filter((l) => l.kind === 'offer').map((l) => l.offerId ?? '');
  if (
    kinds[0] !== 'opening' ||
    kinds[kinds.length - 1] !== 'closing' ||
    offerLines.join('\u0000') !== props.offers.map((o) => o.id).join('\u0000')
  ) {
    issues.push({
      code: 'LINES_STRUCTURE',
      element: 'lines',
      elementId: null,
      message: 'Falas fora da estrutura abertura → uma por oferta (na ordem) → fechamento.',
    });
  }
  const safe = safeAreaFor(props.width, props.height);
  const tol = MC_CAROUSEL_TOKENS.safeAreaTolerancePx;
  const character = carouselFractionsToPx(props.character.window, props.width, props.height);
  if (outside(character, safe, tol)) {
    issues.push({
      code: 'ELEMENT_OUTSIDE_SAFE_AREA',
      element: 'character_window',
      elementId: null,
      message: `A janela do personagem sai da área segura de ${props.width}×${props.height}.`,
    });
  }
  const card = props.cardBox
    ? carouselFractionsToPx(props.cardBox, props.width, props.height)
    : carouselPresetLayout({
        width: props.width,
        height: props.height,
        tileRatio: props.character.tileRatio,
        preset: props.layoutPreset,
        captions: props.captions,
      }).card;
  if (outside(card, safe, tol)) {
    for (const offer of props.offers) {
      issues.push({
        code: 'ELEMENT_OUTSIDE_SAFE_AREA',
        element: 'card',
        elementId: offer.id,
        message: `O card da oferta "${offer.name}" sai da área segura de ${props.width}×${props.height}.`,
      });
    }
  }
  if (intersects(card, character)) {
    issues.push({
      code: 'CARD_OVERLAPS_CHARACTER',
      element: 'card',
      elementId: null,
      message: 'Os cards sobrepõem a janela do personagem.',
    });
  }
  if (
    card.width < MC_CAROUSEL_TOKENS.cardMinWidth ||
    card.height < MC_CAROUSEL_TOKENS.cardMinHeight
  ) {
    issues.push({
      code: 'CARD_TOO_SMALL',
      element: 'card',
      elementId: null,
      message: `Os cards têm ${card.width}×${card.height} px (mínimo 280×240).`,
    });
  }
  return issues;
}

// ───────────────────────── hashes do render ─────────────────────────

/**
 * Hash EXATO do render (spec "Render determinístico"): JSON canônico das
 * props + versão da composição + tipo de renderizador. Mesmas props ⇒ mesmo
 * hash ⇒ o vídeo existente é reaproveitado sem renderizar de novo.
 */
export function computeRenderRemotionPropsHash(input: {
  props: OfferCarouselProps;
  compositionVersion: string;
  renderer: McCarouselRendererKind;
}): string {
  return computeInputHash(McStepType.RENDER_REMOTION, MC_BUILDER_VERSIONS_V2.render_remotion, {
    stage: 'props',
    props: input.props as unknown as Record<string, unknown>,
    compositionVersion: input.compositionVersion,
    renderer: input.renderer,
  });
}

/**
 * Hash das ENTRADAS do render no momento da materialização (aprovação), antes
 * de os clipes existirem: identidades dos clipes (asset final ou
 * `pending:<geração>`) e dos áudios, ofertas, falas, layout, legendas, tile,
 * cor da janela, marca, silêncio, versão da composição e renderizador. O
 * processor grava o hash EXATO das props (`computeRenderRemotionPropsHash`)
 * quando roda.
 */
export function computeRenderRemotionInputsHash(input: {
  clips: Array<{ sceneId: string; finalAssetId: string; audioAssetId: string | null }>;
  offers: McSealProduct[];
  lines: McCarouselLine[];
  aspectRatio: string;
  layoutPreset: string;
  captions: boolean;
  tileAssetId: string | null;
  characterBackgroundColor: string;
  brandName: string | null;
  gapMs: number;
  compositionVersion: string;
  renderer: McCarouselRendererKind;
}): string {
  return computeInputHash(McStepType.RENDER_REMOTION, MC_BUILDER_VERSIONS_V2.render_remotion, {
    stage: 'inputs',
    clips: input.clips.map((c) => ({
      sceneId: c.sceneId,
      finalAssetId: c.finalAssetId,
      audioAssetId: c.audioAssetId,
    })),
    offers: input.offers.map((o) => ({
      id: o.id ?? null,
      name: o.name,
      price: o.price,
      originalPrice: o.originalPrice ?? null,
      unit: o.unit ?? null,
      badge: o.badge ?? null,
      imageUrl: o.imageUrl ?? null,
      catalogId: o.catalogId ?? null,
    })),
    lines: input.lines.map((l) => ({ sceneId: l.sceneId, kind: l.kind, offerRef: l.offerRef })),
    aspectRatio: input.aspectRatio,
    layoutPreset: input.layoutPreset,
    captions: input.captions,
    tileAssetId: input.tileAssetId,
    characterBackgroundColor: input.characterBackgroundColor.trim().toUpperCase(),
    brandName: input.brandName,
    gapMs: input.gapMs,
    compositionVersion: input.compositionVersion,
    renderer: input.renderer,
  });
}
