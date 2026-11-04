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
  prices?: ImageTokenPrices;
  priceSource?: string;
  priceConsultedAt?: string;
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
const SUNBURST_PRICE_SOURCE =
  'https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst; https://developers.openai.com/api/docs/pricing';

export const IMAGE_MODEL_CAPABILITIES: readonly ImageModelCapabilities[] = [
  {
    prefix: 'gpt-image-2.5-sunburst',
    customSizes: true,
    fixedSizes: CLASSIC_SIZES,
    qualities: GPT_IMAGE_2_QUALITIES,
    inputFidelity: false,
    prices: { imageInput: 8, textInput: 5, imageOutput: 30 },
    priceSource: SUNBURST_PRICE_SOURCE,
    priceConsultedAt: '2026-11-02',
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
