import { ConfigService } from '@nestjs/config';

/**
 * As cinco features de IA de produto que o encarte usa (change 01-upgrade-openai-product-models):
 * cada uma tem a sua variável de modelo e a sua variável de prazo. Nenhuma herda
 * `OPENAI_TEXT_MODEL`, `OPENAI_FAST_TEXT_MODEL` (que continuam valendo para o resto do backend)
 * nem `OPENAI_TIMEOUT_MS` (180 s, do provedor de imagem do Template Pro).
 */
export type ProductAiFeature =
  | 'spellcheck'
  | 'categorization'
  | 'nameParser'
  | 'galleryVision'
  | 'translation';

export interface ProductAiFeatureConfig {
  model: string;
  timeoutMs: number;
}

export type ProductAiConfig = Record<ProductAiFeature, ProductAiFeatureConfig>;

interface FeatureDefinition {
  modelVar: string;
  timeoutVar: string;
  defaultModel: string;
  defaultTimeoutMs: number;
}

const FEATURES: Record<ProductAiFeature, FeatureDefinition> = {
  spellcheck: {
    modelVar: 'OPENAI_SPELLCHECK_MODEL',
    timeoutVar: 'OPENAI_SPELLCHECK_TIMEOUT_MS',
    defaultModel: 'gpt-6-luna',
    defaultTimeoutMs: 30_000,
  },
  categorization: {
    modelVar: 'OPENAI_CATEGORIZATION_MODEL',
    timeoutVar: 'OPENAI_CATEGORIZATION_TIMEOUT_MS',
    defaultModel: 'gpt-6-luna',
    defaultTimeoutMs: 60_000,
  },
  nameParser: {
    modelVar: 'OPENAI_NAME_PARSER_MODEL',
    timeoutVar: 'OPENAI_NAME_PARSER_TIMEOUT_MS',
    defaultModel: 'gpt-6-luna',
    defaultTimeoutMs: 60_000,
  },
  galleryVision: {
    modelVar: 'OPENAI_GALLERY_VISION_MODEL',
    timeoutVar: 'OPENAI_GALLERY_VISION_TIMEOUT_MS',
    defaultModel: 'gpt-6.1-terra',
    defaultTimeoutMs: 60_000,
  },
  translation: {
    modelVar: 'OPENAI_TRANSLATION_MODEL',
    timeoutVar: 'OPENAI_TRANSLATION_TIMEOUT_MS',
    defaultModel: 'gpt-6-luna',
    defaultTimeoutMs: 10_000,
  },
};

/** Inteiro positivo da variável; ausente, vazio, zero, negativo ou não numérico vale o padrão. */
export function readPositiveIntegerConfig(
  configService: ConfigService,
  key: string,
  defaultValue: number,
): number {
  const raw = configService.get<string>(key);
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  const parsed = Number(String(raw).trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

/** Texto da variável sem espaços nas pontas; ausente ou vazio vale o padrão. */
export function readModelConfig(
  configService: ConfigService,
  key: string,
  defaultModel: string,
): string {
  const raw = configService.get<string>(key);
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || defaultModel;
}

export function getProductAiConfig(configService: ConfigService): ProductAiConfig {
  const entries = (Object.keys(FEATURES) as ProductAiFeature[]).map((feature) => {
    const def = FEATURES[feature];
    const config: ProductAiFeatureConfig = {
      model: readModelConfig(configService, def.modelVar, def.defaultModel),
      timeoutMs: readPositiveIntegerConfig(configService, def.timeoutVar, def.defaultTimeoutMs),
    };
    return [feature, config] as const;
  });
  return Object.fromEntries(entries) as ProductAiConfig;
}
