import { ConfigService } from '@nestjs/config';
import { OpenAiIntentService } from '../../ai/openai-intent.service';
import { MockSceneIntentClient } from './mock-scene-intent.client';
import { createSceneIntentClient } from './scene-intent-client';

const openai = { classify: jest.fn() } as unknown as OpenAiIntentService;
const build = (env: Record<string, string>) =>
  createSceneIntentClient(new ConfigService(env), openai);

describe('createSceneIntentClient', () => {
  it('openai explícito usa o serviço pago', () => {
    expect(build({ TEMPLATE_SCENE_IMAGE_PROVIDER: 'openai' })).toBe(openai);
  });

  it.each([
    ['mock explícito', { TEMPLATE_SCENE_IMAGE_PROVIDER: 'mock' }],
    ['variável ausente', {}],
    ['valor desconhecido', { TEMPLATE_SCENE_IMAGE_PROVIDER: 'outro' }],
  ])('%s: cai no mock, sem custo', (_label, env) => {
    expect(build(env)).toBeInstanceOf(MockSceneIntentClient);
  });
});
