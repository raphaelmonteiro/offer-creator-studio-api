import { ConfigService } from '@nestjs/config';
import { readModelConfig } from './openai-product-features.config';

/**
 * Padrão de `OPENAI_TEXT_MODEL` e `OPENAI_FAST_TEXT_MODEL` (change 42, D-1): ausente, vazia ou só com espaços vale
 * este. Os pontos que vão para `gpt-6.1-terra` têm variável própria (`openai-strong-models.config.ts`).
 */
export const DEFAULT_TEXT_MODEL = 'gpt-6-luna';

/**
 * Padrões da imagem geral (change 42, D-3): `OPENAI_IMAGE_MODEL` e `OPENAI_IMAGE_PREVIEW_MODEL` ausentes, vazias ou só
 * com espaços valem estes. A cena do Template Pro tem variável própria (`TEMPLATE_SCENE_IMAGE_MODEL`) e não muda.
 */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.6-sunburst';
export const DEFAULT_IMAGE_PREVIEW_MODEL = 'gpt-image-2.6-flare';

export interface OpenAiModelConfig {
  textModel: string;
  fastTextModel: string;
  imageModel: string;
  imagePreviewModel: string;
  imagePreviewQuality: 'low' | 'medium' | 'high' | 'auto';
  imageInputFidelity: 'low' | 'high';
  imageDefaultMode: 'final' | 'preview';
  structuredResponseRetryAttempts: number;
  enableDalleFallback: boolean;
  dalleFallbackModel: string;
}

export function getOpenAiModelConfig(configService: ConfigService): OpenAiModelConfig {
  return {
    textModel: readModelConfig(configService, 'OPENAI_TEXT_MODEL', DEFAULT_TEXT_MODEL),
    fastTextModel: readModelConfig(configService, 'OPENAI_FAST_TEXT_MODEL', DEFAULT_TEXT_MODEL),
    imageModel: readModelConfig(configService, 'OPENAI_IMAGE_MODEL', DEFAULT_IMAGE_MODEL),
    imagePreviewModel: readModelConfig(
      configService,
      'OPENAI_IMAGE_PREVIEW_MODEL',
      DEFAULT_IMAGE_PREVIEW_MODEL,
    ),
    imagePreviewQuality: configService.get<'low' | 'medium' | 'high' | 'auto'>(
      'OPENAI_IMAGE_PREVIEW_QUALITY',
      'medium',
    ),
    imageInputFidelity: configService.get<'low' | 'high'>('OPENAI_IMAGE_INPUT_FIDELITY', 'high'),
    imageDefaultMode: configService.get<'final' | 'preview'>('OPENAI_IMAGE_DEFAULT_MODE', 'final'),
    structuredResponseRetryAttempts: getNonNegativeIntegerConfig(
      configService,
      'OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS',
      1,
    ),
    enableDalleFallback:
      configService.get<string>('OPENAI_ENABLE_DALLE_FALLBACK', 'false') === 'true',
    dalleFallbackModel: configService.get<string>('OPENAI_DALLE_FALLBACK_MODEL', 'dall-e-3'),
  };
}

function getNonNegativeIntegerConfig(
  configService: ConfigService,
  key: string,
  defaultValue: number,
): number {
  const raw = configService.get<string>(key, String(defaultValue));
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}
