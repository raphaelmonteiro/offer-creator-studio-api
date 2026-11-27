import { fakeConfig } from '../utils/openai-chat.testutil';
import { getOpenAiModelConfig } from './openai-models.config';

describe('getOpenAiModelConfig', () => {
  it('usa os modelos de imagem 2.5 por padrao', () => {
    const config = getOpenAiModelConfig(fakeConfig());
    expect(config.imageModel).toBe('gpt-image-2.5-sunburst');
    expect(config.imagePreviewModel).toBe('gpt-image-2.5-flare');
    expect(config.imageInputFidelity).toBe('high');
  });

  it('permite sobrescrever por variavel de ambiente', () => {
    const config = getOpenAiModelConfig(
      fakeConfig({
        OPENAI_IMAGE_MODEL: 'gpt-image-1.5',
        OPENAI_IMAGE_PREVIEW_MODEL: 'gpt-image-1-mini',
        OPENAI_IMAGE_INPUT_FIDELITY: 'low',
      }),
    );
    expect(config.imageModel).toBe('gpt-image-1.5');
    expect(config.imagePreviewModel).toBe('gpt-image-1-mini');
    expect(config.imageInputFidelity).toBe('low');
  });

  describe('modelos de texto (requisito "Variáveis compartilhadas com padrão novo")', () => {
    it('Padrão sem variáveis: os dois valem gpt-6-luna', () => {
      const config = getOpenAiModelConfig(fakeConfig());
      expect(config.textModel).toBe('gpt-6-luna');
      expect(config.fastTextModel).toBe('gpt-6-luna');
    });

    it('Variável de texto muda só o seu grupo', () => {
      const config = getOpenAiModelConfig(fakeConfig({ OPENAI_TEXT_MODEL: 'gpt-4o' }));
      expect(config.textModel).toBe('gpt-4o');
      expect(config.fastTextModel).toBe('gpt-6-luna');
    });

    it('Variável rápida muda só o seu grupo', () => {
      const config = getOpenAiModelConfig(fakeConfig({ OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini' }));
      expect(config.textModel).toBe('gpt-6-luna');
      expect(config.fastTextModel).toBe('gpt-4o-mini');
    });

    it.each([
      ['OPENAI_TEXT_MODEL', 'textModel'],
      ['OPENAI_FAST_TEXT_MODEL', 'fastTextModel'],
    ] as const)('Variável vazia vale como ausente: %s', (name, field) => {
      expect(getOpenAiModelConfig(fakeConfig({ [name]: '' }))[field]).toBe('gpt-6-luna');
      expect(getOpenAiModelConfig(fakeConfig({ [name]: '   ' }))[field]).toBe('gpt-6-luna');
    });

    it('tira os espaços das pontas do valor definido', () => {
      const config = getOpenAiModelConfig(fakeConfig({ OPENAI_TEXT_MODEL: ' gpt-4o ' }));
      expect(config.textModel).toBe('gpt-4o');
    });
  });
});
