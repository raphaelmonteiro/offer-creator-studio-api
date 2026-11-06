/**
 * Capacidades e preços dos modelos de imagem da OpenAI, por prefixo de modelo.
 *
 * Os preços foram copiados de `scripts/template-scene-spike.prices.json` (o app não importa de
 * `scripts/`). Fonte: https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst e
 * https://developers.openai.com/api/docs/pricing, consultadas em 2026-11-02. Entrada sem preço
 * conferido fica sem `prices`: `estimateCostUsd` devolve `null` em vez de inventar um valor.
 *
 * Modelo desconhecido (nenhum prefixo casa) devolve `null` nas duas consultas: sem validação e sem
 * custo, e o caminho legado do `OpenAiImageService` segue como sempre.
 */

export interface ImageTokenPrices {
  /** USD por 1 milhão de tokens de imagem na entrada. */
  imageInput: number;
  /** USD por 1 milhão de tokens de texto na entrada. */
  textInput: number;
  /** USD por 1 milhão de tokens de imagem na saída. */
  imageOutput: number;
}

export interface ImageModelCapabilities {
  /** Prefixo do nome do modelo; vence o prefixo mais longo que casar. */
  prefix: string;
  /** Aceita `LARGURAxALTURA` arbitrário (lados múltiplos de 16, 1:3 a 3:1, borda e área limitadas). */
  customSizes: boolean;
  /** Tamanhos aceitos quando `customSizes` é falso. */
  fixedSizes: readonly string[];
  qualities: readonly string[];
  /** O modelo aceita `input_fidelity` na edição. */
  inputFidelity: boolean;
  /** Aceita `background: transparent` (com `output_format` png ou webp). Ausente = não conferido. */
  transparentBackground?: boolean;
  /** Aceita a edição com `images` + `mask` por corpo JSON (data URL), alfa 255 = editar. Ausente = não conferido. */
  jsonMask?: boolean;
  /**
   * Aceita `markup` (camada de anotação PNG com transparência, mesmas dimensões da imagem, até 16.777.216 px,
   * sem `mask` nem `prompt_rewriter`) em `POST /images/edits`. Ausente = não conferido.
   */
  markup?: boolean;
  prices?: ImageTokenPrices;
  priceSource?: string;
  priceConsultedAt?: string;
  /** Fonte e data da conferência de `transparentBackground` e `jsonMask`. */
  capabilitiesSource?: string;
  capabilitiesConsultedAt?: string;
}

/** Limites dos tamanhos livres (família gpt-image-2 e 2.5). */
export const CUSTOM_SIZE_LIMITS = {
  multiple: 16,
  maxEdge: 3840,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
} as const;

const CLASSIC_SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'] as const;
const GPT_IMAGE_2_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;
/**
 * Guia oficial de geração de imagens, consultado em 2026-11-05: "gpt-image-2.5-sunburst e
 * gpt-image-2.5-flare" aceitam `background: "transparent"` com `output_format` png ou webp, e as
 * edições em JSON usam `images` (e `mask`) com `image_url` em data URL. Conferido só pela leitura da
 * página (nenhuma chamada paga): o teste real fica para a passada do dono.
 */
const CAPABILITIES_SOURCE = 'https://developers.openai.com/api/docs/guides/image-generation';
const SUNBURST_PRICE_SOURCE =
  'https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst; https://developers.openai.com/api/docs/pricing';
/**
 * Modelo da cena (change add-template-scene-conversation). Preço: páginas `models/gpt-image-2.6-sunburst` e
 * `pricing`, tier padrão, consultadas em 2026-11-06: imagem de entrada US$ 8, texto de entrada US$ 5 e imagem de
 * saída US$ 30 por milhão de tokens (iguais às do 2.5). `markup`: guia `guides/image-generation`, seção "Guide an
 * edit with markup", mesma data.
 */
const SUNBURST_2_6_PRICE_SOURCE =
  'https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst; https://developers.openai.com/api/docs/pricing';
/** Limite de pixels da imagem e da camada `markup` (guia de imagens, 2026-11-06). */
export const MARKUP_MAX_PIXELS = 16_777_216;

export const IMAGE_MODEL_CAPABILITIES: readonly ImageModelCapabilities[] = [
  {
    prefix: 'gpt-image-2.6-sunburst',
    customSizes: true,
    fixedSizes: CLASSIC_SIZES,
    qualities: GPT_IMAGE_2_QUALITIES,
    inputFidelity: false,
    transparentBackground: true,
    markup: true,
    prices: { imageInput: 8, textInput: 5, imageOutput: 30 },
    priceSource: SUNBURST_2_6_PRICE_SOURCE,
    priceConsultedAt: '2026-11-06',
    capabilitiesSource: CAPABILITIES_SOURCE,
    capabilitiesConsultedAt: '2026-11-06',
  },
  {
    prefix: 'gpt-image-2.5-sunburst',
    customSizes: true,
    fixedSizes: CLASSIC_SIZES,
    qualities: GPT_IMAGE_2_QUALITIES,
    inputFidelity: false,
    transparentBackground: true,
    jsonMask: true,
    prices: { imageInput: 8, textInput: 5, imageOutput: 30 },
    priceSource: SUNBURST_PRICE_SOURCE,
    priceConsultedAt: '2026-11-02',
    capabilitiesSource: CAPABILITIES_SOURCE,
    capabilitiesConsultedAt: '2026-11-05',
  },
  {
    prefix: 'gpt-image-2.5',
    customSizes: true,
    fixedSizes: CLASSIC_SIZES,
    qualities: GPT_IMAGE_2_QUALITIES,
    inputFidelity: false,
  },
  {
    prefix: 'gpt-image-2',
    customSizes: true,
    fixedSizes: CLASSIC_SIZES,
    qualities: GPT_IMAGE_2_QUALITIES,
    inputFidelity: false,
  },
  {
    prefix: 'chatgpt-image-latest',
    customSizes: true,
    fixedSizes: CLASSIC_SIZES,
    qualities: GPT_IMAGE_2_QUALITIES,
    inputFidelity: false,
  },
  {
    prefix: 'gpt-image-1.5',
    customSizes: false,
    fixedSizes: CLASSIC_SIZES,
    qualities: ['low', 'medium', 'high', 'auto'],
    inputFidelity: true,
  },
  {
    prefix: 'gpt-image-1-mini',
    customSizes: false,
    fixedSizes: CLASSIC_SIZES,
    qualities: ['low', 'medium', 'high', 'auto'],
    inputFidelity: true,
  },
];

/** `usage` da resposta de `images.generate` / `images.edit`. */
export interface ImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
}

export function findImageModelCapabilities(model: string): ImageModelCapabilities | null {
  const matches = IMAGE_MODEL_CAPABILITIES.filter((entry) => model.startsWith(entry.prefix));
  if (matches.length === 0) return null;
  return matches.reduce((best, entry) => (entry.prefix.length > best.prefix.length ? entry : best));
}

function parseSize(size: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function customSizeProblem(size: string): string | null {
  const parsed = parseSize(size);
  if (!parsed) return `tamanho "${size}" fora do formato LARGURAxALTURA`;
  const { width, height } = parsed;
  const { multiple, maxEdge, maxRatio, minPixels, maxPixels } = CUSTOM_SIZE_LIMITS;
  if (width % multiple !== 0 || height % multiple !== 0) {
    return `${size}: os lados precisam ser múltiplos de ${multiple}`;
  }
  if (Math.max(width, height) > maxEdge) return `${size}: borda acima de ${maxEdge} px`;
  if (Math.max(width, height) / Math.min(width, height) > maxRatio) {
    return `${size}: proporção fora de 1:${maxRatio} a ${maxRatio}:1`;
  }
  const pixels = width * height;
  if (pixels < minPixels || pixels > maxPixels) {
    return `${size}: área fora de ${minPixels} a ${maxPixels} px`;
  }
  return null;
}

/**
 * Motivo da recusa do tamanho para o modelo, ou `null` quando vale (ou quando o modelo é
 * desconhecido: sem tabela, sem validação).
 */
export function validateImageSize(model: string, size: string): string | null {
  const capabilities = findImageModelCapabilities(model);
  if (!capabilities) return null;
  if (capabilities.fixedSizes.includes(size)) return null;
  if (!capabilities.customSizes) {
    return `${model} aceita só ${capabilities.fixedSizes.join(', ')}; recebeu ${size}`;
  }
  return customSizeProblem(size);
}

/** Motivo da recusa da qualidade para o modelo, ou `null` (modelo desconhecido não valida). */
export function validateImageQuality(model: string, quality: string): string | null {
  const capabilities = findImageModelCapabilities(model);
  if (!capabilities || capabilities.qualities.includes(quality)) return null;
  return `${model} não aceita a qualidade "${quality}" (aceita ${capabilities.qualities.join(', ')})`;
}

/** Motivo da recusa de `background: transparent`, ou `null` (fundo opaco/auto e modelo desconhecido passam). */
export function validateImageBackground(model: string, background: string): string | null {
  const capabilities = findImageModelCapabilities(model);
  if (!capabilities || background !== 'transparent' || capabilities.transparentBackground) {
    return null;
  }
  return `${model} não tem fundo transparente conferido na tabela de capacidades`;
}

/** Motivo da recusa da edição com máscara por JSON, ou `null` (modelo desconhecido não valida). */
export function validateImageMask(model: string): string | null {
  const capabilities = findImageModelCapabilities(model);
  if (!capabilities || capabilities.jsonMask) return null;
  return `${model} não tem a edição com máscara por JSON conferida na tabela de capacidades`;
}

/** Motivo da recusa do `markup`, ou `null` (modelo desconhecido não valida). */
export function validateImageMarkup(model: string): string | null {
  const capabilities = findImageModelCapabilities(model);
  if (!capabilities || capabilities.markup) return null;
  return `${model} não tem a edição com markup conferida na tabela de capacidades`;
}

/** `true` quando a tabela traz preço conferido para o modelo (modelo desconhecido e entrada sem `prices`: `false`). */
export function hasConfirmedPrice(model: string): boolean {
  return Boolean(findImageModelCapabilities(model)?.prices);
}

const MILLION = 1_000_000;

/**
 * Custo em USD a partir do `usage` e da tabela: `(imagem * imageInput + texto * textInput +
 * saída * imageOutput) / 1e6`. Sem o detalhe da entrada, todos os tokens de entrada contam como
 * texto. `null` sem `usage`, sem preço conferido ou para modelo desconhecido.
 */
export function estimateCostUsd(
  model: string,
  usage: ImageUsage | null | undefined,
): number | null {
  const prices = findImageModelCapabilities(model)?.prices;
  if (!prices || !usage) return null;
  const details = usage.input_tokens_details;
  const imageTokens = details?.image_tokens ?? 0;
  const textTokens = details ? (details.text_tokens ?? 0) : (usage.input_tokens ?? 0);
  const cost =
    (imageTokens * prices.imageInput +
      textTokens * prices.textInput +
      (usage.output_tokens ?? 0) * prices.imageOutput) /
    MILLION;
  return Math.round(cost * MILLION) / MILLION;
}
