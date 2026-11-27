import { fakeConfig } from '../utils/openai-chat.testutil';
import { getOpenAiModelConfig } from './openai-models.config';

describe('getOpenAiModelConfig', () => {
  it('Padrão sem variáveis de imagem: 2.6 sunburst na geral e 2.6 flare na prévia', () => {
    const config = getOpenAiModelConfig(fakeConfig());
    expect(config.imageModel).toBe('gpt-image-2.6-sunburst');
    expect(config.imagePreviewModel).toBe('gpt-image-2.6-flare');
    expect(config.imageInputFidelity).toBe('high');
  });

  it.each([
    ['OPENAI_IMAGE_MODEL', 'imageModel', 'gpt-image-2.6-sunburst'],
    ['OPENAI_IMAGE_PREVIEW_MODEL', 'imagePreviewModel', 'gpt-image-2.6-flare'],
  ] as const)(
    'Variável de imagem vazia ou com espaços vale como ausente: %s',
    (name, field, expected) => {
      expect(getOpenAiModelConfig(fakeConfig({ [name]: '' }))[field]).toBe(expected);
      expect(getOpenAiModelConfig(fakeConfig({ [name]: '   ' }))[field]).toBe(expected);
    },
  );

  it('Volta ao 2.5 pela variável, só do modelo escolhido', () => {
    const config = getOpenAiModelConfig(
      fakeConfig({ OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst' }),
    );
    expect(config.imageModel).toBe('gpt-image-2.5-sunburst');
    expect(config.imagePreviewModel).toBe('gpt-image-2.6-flare');
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
