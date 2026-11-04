import { HttpException, HttpStatus } from '@nestjs/common';

/** Erros da API da cena: envelope `{code, message, details}` com mensagem em pt-BR. */
function sceneError(
  status: HttpStatus,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HttpException {
  return new HttpException({ code, message, ...(details ? { details } : {}) }, status);
}

export const sceneDisabled = () =>
  sceneError(HttpStatus.NOT_FOUND, 'TEMPLATE_SCENE_DISABLED', 'Recurso não disponível');

export const sceneNotFound = () =>
  sceneError(HttpStatus.NOT_FOUND, 'SCENE_NOT_FOUND', 'Cena não encontrada.');

export const versionNotFound = () =>
  sceneError(HttpStatus.NOT_FOUND, 'VERSION_NOT_FOUND', 'Versão não encontrada nesta cena.');

export const revisionConflict = (currentRevision: number) =>
  sceneError(
    HttpStatus.CONFLICT,
    'REVISION_CONFLICT',
    'A cena mudou em outra aba ou por outra pessoa. Recarregue para continuar.',
    { revision: currentRevision },
  );

export const sceneBusy = (versionId?: string) =>
  sceneError(
    HttpStatus.CONFLICT,
    'SCENE_BUSY',
    'A cena está processando um pedido. Aguarde terminar ou cancele.',
    versionId ? { versionId } : undefined,
  );

export const versionNotCancellable = (status: string) =>
  sceneError(
    HttpStatus.CONFLICT,
    'VERSION_NOT_CANCELLABLE',
    'Esta versão já terminou e não pode ser cancelada.',
    { status },
  );

export const versionNotRestorable = () =>
  sceneError(
    HttpStatus.GONE,
    'VERSION_NOT_RESTORABLE',
    'Esta versão é antiga demais: guardamos a imagem só das 5 versões mais recentes e das aprovadas.',
    { reason: 'master_purged' },
  );

export const versionNotReady = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'VERSION_NOT_READY',
    'Só é possível restaurar uma versão pronta.',
  );

export const sceneFormatUnsupported = (formatId: string) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SCENE_FORMAT_UNSUPPORTED',
    'Este formato não é suportado nas cenas de template.',
    { formatId },
  );

export const sceneEditUnavailable = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SCENE_EDIT_UNAVAILABLE',
    'A edição da cena por mensagem ainda não está disponível. Só a primeira geração funciona nesta versão.',
  );

export const logoInvalid = (reason: string) =>
  sceneError(HttpStatus.UNPROCESSABLE_ENTITY, 'LOGO_INVALID', reason);

export const assetNotInScene = (assetId: string) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'ASSET_NOT_IN_SCENE',
    'A imagem informada não pertence a esta cena.',
    { assetId },
  );

export const invalidBody = (message: string) =>
  sceneError(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', message);

export const adminTokenInvalid = () =>
  sceneError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Token administrativo inválido.');
