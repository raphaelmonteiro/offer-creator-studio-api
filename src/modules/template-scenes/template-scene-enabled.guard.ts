import { CanActivate, Injectable } from '@nestjs/common';
import { sceneDisabled } from './scene.errors';

/**
 * Feature flag do módulo: com `TEMPLATE_SCENE_ENABLED !== 'true'` as rotas respondem 404
 * `TEMPLATE_SCENE_DISABLED`. O módulo fica sempre registrado, e o consumer da fila tem o mesmo gate.
 */
@Injectable()
export class TemplateSceneEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.TEMPLATE_SCENE_ENABLED !== 'true') throw sceneDisabled();
    return true;
  }
}
