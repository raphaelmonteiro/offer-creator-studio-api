import { fakeConfig } from '../utils/openai-chat.testutil';
import { getOpenAiModelConfig } from './openai-models.config';
import { getProductAiConfig } from './openai-product-features.config';
import { getStrongModelConfig } from './openai-strong-models.config';

describe('getStrongModelConfig (requisito "Modelo próprio para diretor, descrição do kit e juízes de EAN")', () => {
  it('Padrão Terra: diretor, descrição do kit e os dois juízes valem gpt-6.1-terra', () => {
    expect(getStrongModelConfig(fakeConfig())).toEqual({
      directorModel: 'gpt-6.1-terra',
      kitVisionModel: 'gpt-6.1-terra',
      eanJudgeModelA: 'gpt-6.1-terra',
      eanJudgeModelB: 'gpt-6.1-terra',
    });
  });

  it('Volta só do diretor: a descrição do kit continua em gpt-6.1-terra', () => {
    const config = getStrongModelConfig(fakeConfig({ MC_DIRECTOR_MODEL: 'gpt-4o' }));
    expect(config.directorModel).toBe('gpt-4o');
    expect(config.kitVisionModel).toBe('gpt-6.1-terra');
  });

  it('Juiz B segue o A', () => {
    const config = getStrongModelConfig(
      fakeConfig({ EAN_JUDGE_MODEL_A: 'gpt-6-luna', EAN_JUDGE_MODEL_B: '' }),
    );
    expect(config.eanJudgeModelA).toBe('gpt-6-luna');
    expect(config.eanJudgeModelB).toBe('gpt-6-luna');
  });

  it('Juiz B definido não segue o A', () => {
    const config = getStrongModelConfig(
      fakeConfig({ EAN_JUDGE_MODEL_A: 'gpt-6-luna', EAN_JUDGE_MODEL_B: 'gpt-6.1-terra' }),
    );
    expect(config.eanJudgeModelB).toBe('gpt-6.1-terra');
  });

  it('Variáveis compartilhadas não mudam as cinco features nem os pontos de modelo próprio', () => {
    const env = { OPENAI_TEXT_MODEL: 'gpt-4o', OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini' };
    expect(getProductAiConfig(fakeConfig(env)).spellcheck.model).toBe('gpt-6-luna');
    const strong = getStrongModelConfig(fakeConfig(env));
    expect(strong.directorModel).toBe('gpt-6.1-terra');
    expect(strong.kitVisionModel).toBe('gpt-6.1-terra');
    expect(strong.eanJudgeModelA).toBe('gpt-6.1-terra');
    expect(getOpenAiModelConfig(fakeConfig(env)).textModel).toBe('gpt-4o');
  });

  it.each([
    ['MC_DIRECTOR_MODEL', 'directorModel'],
    ['MC_KIT_VISION_MODEL', 'kitVisionModel'],
    ['EAN_JUDGE_MODEL_A', 'eanJudgeModelA'],
    ['EAN_JUDGE_MODEL_B', 'eanJudgeModelB'],
  ] as const)('Variável vazia ou só com espaços vale como ausente: %s', (name, field) => {
    expect(getStrongModelConfig(fakeConfig({ [name]: '' }))[field]).toBe('gpt-6.1-terra');
    expect(getStrongModelConfig(fakeConfig({ [name]: '  ' }))[field]).toBe('gpt-6.1-terra');
  });

  it('Juiz B só com espaços segue o A, que foi definido', () => {
    const config = getStrongModelConfig(
      fakeConfig({ EAN_JUDGE_MODEL_A: 'gpt-6-luna', EAN_JUDGE_MODEL_B: '  ' }),
    );
    expect(config.eanJudgeModelB).toBe('gpt-6-luna');
  });
});
