import { HttpException } from '@nestjs/common';
import { TemplateSceneReferenceEnabledGuard } from './template-scene-reference-enabled.guard';

describe('TemplateSceneReferenceEnabledGuard', () => {
  const original = process.env.TEMPLATE_SCENE_REFERENCE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.TEMPLATE_SCENE_REFERENCE_ENABLED;
    else process.env.TEMPLATE_SCENE_REFERENCE_ENABLED = original;
  });

  it('libera com a flag ligada', () => {
    process.env.TEMPLATE_SCENE_REFERENCE_ENABLED = 'true';
    expect(new TemplateSceneReferenceEnabledGuard().canActivate()).toBe(true);
  });

  it.each([undefined, 'false', '1', 'TRUE', ''])(
    'responde 404 REFERENCE_DISABLED com a flag %p',
    (value) => {
      if (value === undefined) delete process.env.TEMPLATE_SCENE_REFERENCE_ENABLED;
      else process.env.TEMPLATE_SCENE_REFERENCE_ENABLED = value;
      let thrown: HttpException | undefined;
      try {
        new TemplateSceneReferenceEnabledGuard().canActivate();
      } catch (error) {
        thrown = error as HttpException;
      }
      expect(thrown?.getStatus()).toBe(404);
      expect(thrown?.getResponse()).toMatchObject({ code: 'REFERENCE_DISABLED' });
    },
  );
});
