import { ConfigService } from '@nestjs/config';

export interface OpenAiModelConfig {
  textModel: string;
  fastTextModel: string;
  imageModel: string;
  imageFallbackModel: string;
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
    textModel: configService.get<string>('OPENAI_TEXT_MODEL', 'gpt-4o'),
    fastTextModel: configService.get<string>('OPENAI_FAST_TEXT_MODEL', 'gpt-4o-mini'),
    imageModel: configService.get<string>('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
    imageFallbackModel: configService.get<string>('OPENAI_IMAGE_FALLBACK_MODEL', 'gpt-image-1'),
    imagePreviewModel: configService.get<string>('OPENAI_IMAGE_PREVIEW_MODEL', 'gpt-image-1-mini'),
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
