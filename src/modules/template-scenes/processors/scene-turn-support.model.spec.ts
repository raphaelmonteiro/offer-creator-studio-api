import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { SceneTurnSupport } from './scene-turn-support';

const supportWith = (env: Record<string, string>) =>
  new SceneTurnSupport({} as never, {} as never, fakeConfig(env));

describe('SceneTurnSupport.model (a cena do Template Pro não segue o modelo da imagem geral)', () => {
  it('Cena do Template Pro não muda: OPENAI_IMAGE_MODEL=2.5 e TEMPLATE_SCENE_IMAGE_MODEL=2.6 usa o 2.6', () => {
    const support = supportWith({
      OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
      TEMPLATE_SCENE_IMAGE_MODEL: 'gpt-image-2.6-sunburst',
    });
    expect(support.model()).toBe('gpt-image-2.6-sunburst');
  });

  it('só OPENAI_IMAGE_MODEL definida: a cena fica no padrão próprio, não no da imagem geral', () => {
    const support = supportWith({ OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst' });
    expect(support.model()).toBe('gpt-image-2.6-sunburst');
  });
});
