import { ConfigService } from '@nestjs/config';
import { OpenAiImageService } from '../../ai/openai-image.service';
import { createSceneImageProvider } from './scene-image-provider.factory';

describe('createSceneImageProvider', () => {
  const images = {} as OpenAiImageService;
  const nameFor = (env: Record<string, string>) =>
    createSceneImageProvider(new ConfigService(env), images).name;

  it('mock por padrão', () => {
    expect(nameFor({})).toBe('mock');
  });

  it('openai só quando pedido', () => {
    expect(nameFor({ TEMPLATE_SCENE_IMAGE_PROVIDER: 'openai' })).toBe('openai');
  });

  it.each(['', 'OPENAI', 'dalle', 'real'])(
    'valor %p cai no mock (sem chamada paga por engano)',
    (value) => {
      expect(nameFor({ TEMPLATE_SCENE_IMAGE_PROVIDER: value })).toBe('mock');
    },
  );
});
