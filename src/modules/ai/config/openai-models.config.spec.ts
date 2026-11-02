import { ConfigService } from '@nestjs/config';
import { getOpenAiModelConfig } from './openai-models.config';

function build(env: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => (key in env ? env[key] : fallback),
  } as unknown as ConfigService;
}

describe('getOpenAiModelConfig', () => {
  it('usa os modelos de imagem 2.5 por padrao', () => {
    const config = getOpenAiModelConfig(build());
    expect(config.imageModel).toBe('gpt-image-2.5-sunburst');
    expect(config.imagePreviewModel).toBe('gpt-image-2.5-flare');
    expect(config.imageInputFidelity).toBe('high');
  });

  it('permite sobrescrever por variavel de ambiente', () => {
    const config = getOpenAiModelConfig(
      build({
        OPENAI_IMAGE_MODEL: 'gpt-image-1.5',
        OPENAI_IMAGE_PREVIEW_MODEL: 'gpt-image-1-mini',
        OPENAI_IMAGE_INPUT_FIDELITY: 'low',
      }),
    );
    expect(config.imageModel).toBe('gpt-image-1.5');
    expect(config.imagePreviewModel).toBe('gpt-image-1-mini');
    expect(config.imageInputFidelity).toBe('low');
  });
});
