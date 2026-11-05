import { HttpException } from '@nestjs/common';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

describe('TemplateSceneEnabledGuard', () => {
  const original = process.env.TEMPLATE_SCENE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.TEMPLATE_SCENE_ENABLED;
    else process.env.TEMPLATE_SCENE_ENABLED = original;
  });

  it('libera com a flag ligada', () => {
    process.env.TEMPLATE_SCENE_ENABLED = 'true';
    expect(new TemplateSceneEnabledGuard().canActivate()).toBe(true);
  });

  it.each([undefined, 'false', '1', 'TRUE', ''])('responde 404 com a flag %p', (value) => {
    if (value === undefined) delete process.env.TEMPLATE_SCENE_ENABLED;
    else process.env.TEMPLATE_SCENE_ENABLED = value;
    let thrown: HttpException | undefined;
    try {
      new TemplateSceneEnabledGuard().canActivate();
    } catch (error) {
      thrown = error as HttpException;
    }
    expect(thrown?.getStatus()).toBe(404);
    expect(thrown?.getResponse()).toMatchObject({ code: 'TEMPLATE_SCENE_DISABLED' });
  });
});
