import { CanActivate, Injectable } from '@nestjs/common';
import { referenceDisabled } from './scene.errors';

/**
 * Liberação própria da referência de encarte (PV-R1): cada uso custa cerca de US$ 0,14. Com
 * `TEMPLATE_SCENE_REFERENCE_ENABLED !== 'true'` as três rotas respondem 404 `REFERENCE_DISABLED`, sem gravar nada.
 * Roda depois do login e da flag da cena (guards do controller).
 */
@Injectable()
export class TemplateSceneReferenceEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (process.env.TEMPLATE_SCENE_REFERENCE_ENABLED !== 'true') throw referenceDisabled();
    return true;
  }
}
