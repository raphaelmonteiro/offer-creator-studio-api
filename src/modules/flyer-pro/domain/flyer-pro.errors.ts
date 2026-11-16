import { HttpException, HttpStatus } from '@nestjs/common';
import type { FlyerProFaceKey, FlyerProLayout } from './flyer-pro.types';

/** Erros da API do Encarte Pro: envelope `{ code, message, details }` com mensagem em pt-BR. */
export function flyerProError(
  status: HttpStatus,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  return new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}

/** Cena inexistente, excluída ou sem nenhuma face pronta (a cópia não nasce). */
export const flyerProTemplateNotFound = () =>
  flyerProError(HttpStatus.NOT_FOUND, 'FLYER_PRO_TEMPLATE_NOT_FOUND', 'Template não encontrado.');

/** `reason`: `FORMAT` para formato fora de 27×40 e 54×40; `LAYOUT` para o layout que o formato não aceita. */
export const flyerProTemplateUnsupported = (details: {
  reason: 'FORMAT' | 'LAYOUT';
  formatId: string;
  layout: FlyerProLayout | string;
}) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_TEMPLATE_UNSUPPORTED',
    'Este template não pode ser usado no Encarte Pro.',
    details,
  );

export const flyerProTemplateIncomplete = (missingFaces: FlyerProFaceKey[]) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_TEMPLATE_INCOMPLETE',
    'Este template ainda não tem todas as faces prontas.',
    { missingFaces },
  );
