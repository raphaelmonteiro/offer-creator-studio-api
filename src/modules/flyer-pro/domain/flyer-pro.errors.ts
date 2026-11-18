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

/** Encarte inexistente, excluído ou id que não é UUID: o mesmo 404 para os três. */
export const flyerProNotFound = () =>
  flyerProError(HttpStatus.NOT_FOUND, 'FLYER_PRO_NOT_FOUND', 'Encarte não encontrado ou excluído.');

/** O mesmo erro e a mesma mensagem do `ClientsService`, que o monta no próprio serviço. */
export const flyerProClientNotFound = () =>
  flyerProError(HttpStatus.NOT_FOUND, 'CLIENT_NOT_FOUND', 'Cliente não encontrado');

/** O pipe pula o corpo `{}`; o serviço confere os obrigatórios à mão e recusa com a lista dos que faltam. */
export const flyerProMissingFields = (fields: string[]) =>
  flyerProError(
    HttpStatus.BAD_REQUEST,
    'BAD_REQUEST',
    `Campos obrigatórios ausentes: ${fields.join(', ')}.`,
  );

/** 400 de forma que o `class-validator` não pega (corpo `{}`, ids repetidos): o mesmo `code` do pipe. */
export const flyerProBadRequest = (message: string) =>
  flyerProError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', message);

/** O cliente viu uma revisão diferente da atual; `details` é o que o diálogo de conflito mostra (PU-03). */
export const flyerProRevisionConflict = (details: {
  revision: number;
  updatedAt: string;
  updatedByUserId: string | null;
}) =>
  flyerProError(
    HttpStatus.CONFLICT,
    'REVISION_CONFLICT',
    'O encarte mudou em outra aba ou por outra pessoa. Recarregue para continuar.',
    details,
  );

/** O app que enviou é mais antigo que o gravado; `details` traz as versões gravadas. */
export const flyerProAppOutdated = (details: { schemaVersion: number; engineVersion: number }) =>
  flyerProError(
    HttpStatus.CONFLICT,
    'FLYER_PRO_APP_OUTDATED',
    'Há uma versão nova do app. Recarregue a página para continuar.',
    details,
  );

/** `slice` é uma fatia, `layoutSnapshot` ou `body`. */
export const flyerProSliceTooLarge = (details: { slice: string; bytes: number; max: number }) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_SLICE_TOO_LARGE',
    'Parte do encarte grande demais para salvar.',
    details,
  );

export const flyerProUiTooLarge = (details: { bytes: number; max: number }) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_UI_TOO_LARGE',
    'Estado de tela grande demais para salvar.',
    details,
  );

/** Trocar para template de outro formato com as páginas congeladas. */
export const flyerProFoldLocked = (details: { format: string; newFormat: string }) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_FOLD_LOCKED',
    'As páginas já foram montadas: não é possível trocar para um template de outro formato.',
    details,
  );

export const flyerProPageCountInvalid = (details: { format: string; allowed: number[] }) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_PAGE_COUNT_INVALID',
    'Número de páginas inválido para o formato.',
    details,
  );

/** O problema de um campo de um item; a lista inteira vai em `issues` (fora de `details`: o `httpClient` do front a lê). */
export interface FlyerProItemIssue {
  itemId: string;
  field: string;
  code: string;
}

export const flyerProItemInvalid = (issues: FlyerProItemIssue[]) =>
  new HttpException(
    {
      code: 'FLYER_PRO_ITEM_INVALID',
      message: 'Há itens com dados inválidos.',
      issues,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );

export const flyerProItemLimit = (details: { max: number; total: number }) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_ITEM_LIMIT',
    'O encarte passaria de 500 itens.',
    details,
  );

/** Ids de itens que pertencem a outro encarte. */
export const flyerProItemIdConflict = (itemIds: string[]) =>
  flyerProError(
    HttpStatus.CONFLICT,
    'FLYER_PRO_ITEM_ID_CONFLICT',
    'Há itens que pertencem a outro encarte.',
    { itemIds },
  );
