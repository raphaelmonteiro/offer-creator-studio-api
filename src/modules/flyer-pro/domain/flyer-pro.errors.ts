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

/**
 * O problema de um campo de um registro ou de um retrato: `field` é o caminho e `code` o motivo. É a forma de `issues`
 * do registro da importação, do retrato da Estrutura e do registro da exportação.
 */
export interface FlyerProFieldIssue {
  field: string;
  code: string;
}

/** O problema de um campo do registro de uma importação. */
export type FlyerProImportIssue = FlyerProFieldIssue;

/** O 422 com a lista de problemas em `issues`, fora de `details`: o mesmo envelope dos itens e das importações. */
const flyerProIssues = (code: string, message: string, issues: Array<object>) =>
  new HttpException({ code, message, issues }, HttpStatus.UNPROCESSABLE_ENTITY);

export const flyerProItemInvalid = (issues: FlyerProItemIssue[]) =>
  flyerProIssues('FLYER_PRO_ITEM_INVALID', 'Há itens com dados inválidos.', issues);

/** O registro da importação com contagens incoerentes (`COUNT_MISMATCH`, `EMPTY`). */
export const flyerProImportInvalid = (issues: FlyerProImportIssue[]) =>
  flyerProIssues('FLYER_PRO_IMPORT_INVALID', 'O registro da importação está incoerente.', issues);

/** O registro da exportação incoerente (`PRESET_MISMATCH`, `FILE_NAME_EXTENSION`, `REVISION_AHEAD`): todos de uma vez. */
export const flyerProExportInvalid = (issues: FlyerProFieldIssue[]) =>
  flyerProIssues('FLYER_PRO_EXPORT_INVALID', 'O registro da exportação está incoerente.', issues);

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

/** O `import.id` já é de uma importação de outro encarte, vivo ou excluído. */
export const flyerProImportIdConflict = (importId: string) =>
  flyerProError(
    HttpStatus.CONFLICT,
    'FLYER_PRO_IMPORT_ID_CONFLICT',
    'A importação pertence a outro encarte.',
    { importId },
  );

/** O `id` do registro já é de uma exportação de outro encarte, vivo ou excluído. */
export const flyerProExportIdConflict = (exportId: string) =>
  flyerProError(
    HttpStatus.CONFLICT,
    'FLYER_PRO_EXPORT_ID_CONFLICT',
    'A exportação pertence a outro encarte.',
    { exportId },
  );

/** O problema de uma conferência do retrato da Estrutura (N19). */
export type FlyerProStructureIssue = FlyerProFieldIssue;

/** O retrato da Estrutura incoerente: todos os problemas de uma vez em `issues`, fora de `details`. */
export const flyerProStructureStateInvalid = (issues: FlyerProStructureIssue[]) =>
  flyerProIssues(
    'FLYER_PRO_STRUCTURE_STATE_INVALID',
    'O retrato da Estrutura enviado está incoerente.',
    issues,
  );

/** `FLAG`: variável desligada; `NO_API_KEY` e `MODEL_PRICE_UNKNOWN`: o provedor real não pode ser chamado. */
export type StructureAiDisabledReason = 'FLAG' | 'NO_API_KEY' | 'MODEL_PRICE_UNKNOWN';

export const flyerProStructureAiDisabled = (reason: StructureAiDisabledReason) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_STRUCTURE_AI_DISABLED',
    'A sugestão por IA está desligada neste ambiente.',
    { reason },
  );

export type StructureAiBusyReason = 'IN_FLIGHT' | 'HOURLY_LIMIT';

const BUSY_MESSAGES: Record<StructureAiBusyReason, string> = {
  IN_FLIGHT: 'Já há uma sugestão em andamento para este encarte.',
  HOURLY_LIMIT: 'Limite de sugestões por hora atingido.',
};

/** `retryAfterSeconds`: segundos, arredondados para cima, até a vaga ou a janela abrir. */
export const flyerProStructureAiBusy = (details: {
  reason: StructureAiBusyReason;
  retryAfterSeconds: number;
}) =>
  flyerProError(
    HttpStatus.TOO_MANY_REQUESTS,
    'FLYER_PRO_STRUCTURE_AI_BUSY',
    BUSY_MESSAGES[details.reason],
    details,
  );

export type StructureAiFailureReason = 'PROVIDER_ERROR' | 'TIMEOUT' | 'INVALID_OUTPUT';

/** Sem plano de reserva: `suggestionId` é o que o log da chamada traz. */
export const flyerProStructureAiFailed = (details: {
  reason: StructureAiFailureReason;
  suggestionId: string;
}) =>
  flyerProError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'FLYER_PRO_STRUCTURE_AI_FAILED',
    'A sugestão não ficou pronta. Nada foi alterado.',
    details,
  );

/** Nenhum id do pedido é item do encarte (a N14 reaproveita o código); `details` vazio, para o filtro não repetir a mensagem. */
export const flyerProNoItems = () =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_NO_ITEMS',
    'Não há itens do encarte neste pedido.',
    {},
  );
