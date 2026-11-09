import { HttpException, HttpStatus } from '@nestjs/common';
import type { FaceKey } from './domain/scene-faces';

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
    'Esta versão é antiga demais: guardamos a imagem só das 20 versões mais recentes, das aprovadas e da atual.',
    { reason: 'master_purged' },
  );

export const versionNotReady = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'VERSION_NOT_READY',
    'Só é possível restaurar uma versão pronta.',
  );

export const noCurrentVersion = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'NO_CURRENT_VERSION',
    'A cena ainda não tem imagem. Gere a cena antes de editar as camadas.',
  );

export const sceneFormatUnsupported = (formatId: string) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SCENE_FORMAT_UNSUPPORTED',
    'Este formato não é suportado nas cenas de template.',
    { formatId },
  );

export const sceneLayoutUnsupported = (formatId: string, layout: string) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SCENE_LAYOUT_UNSUPPORTED',
    layout === 'tabloid'
      ? 'O jornal de 4 páginas só existe no formato folheto 54x40.'
      : 'Este formato não aceita frente e verso. Escolha um formato em retrato.',
    { formatId, layout },
  );

export const faceNotFound = (face: string) =>
  sceneError(HttpStatus.UNPROCESSABLE_ENTITY, 'FACE_NOT_FOUND', 'Esta cena não tem essa face.', {
    face,
  });

/** `details.faceKey` (`back` ou `inner`) diz qual face a derivação recusou (PV-T5); só a mensagem da Interna é própria. */
export const frontNotReady = (faceKey?: FaceKey) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FRONT_NOT_READY',
    faceKey === 'inner'
      ? 'Faça a externa primeiro: a interna nasce dela.'
      : 'Faça a frente primeiro: o verso nasce dela.',
    faceKey ? { faceKey } : undefined,
  );

export const backAlreadyExists = (faceKey?: FaceKey) =>
  sceneError(
    HttpStatus.CONFLICT,
    'BACK_ALREADY_EXISTS',
    faceKey === 'inner'
      ? 'A interna já existe e nasce da externa. Peça os ajustes na aba Interna, ou volte a uma versão anterior dela.'
      : 'O verso já existe e nasce da frente. Peça os ajustes na aba Verso, ou volte a uma versão anterior dele.',
    faceKey ? { faceKey } : undefined,
  );

export const regionTooSmall = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'REGION_TOO_SMALL',
    'A área marcada é pequena demais. Marque uma área maior (pelo menos 0,1% da imagem).',
  );

export const targetElementNotFound = (elementId: string) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'TARGET_ELEMENT_NOT_FOUND',
    'O elemento selecionado não existe mais nesta cena.',
    { elementId },
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

/** Referência de encarte (change add-template-scene-from-reference). */
export const referenceDisabled = () =>
  sceneError(HttpStatus.NOT_FOUND, 'REFERENCE_DISABLED', 'Recurso não disponível');

export const referenceInvalid = (message: string) =>
  sceneError(HttpStatus.UNPROCESSABLE_ENTITY, 'REFERENCE_INVALID', message);

export const referenceOnlyAtStart = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'REFERENCE_ONLY_AT_START',
    'A referência vale só para começar o template.',
  );

export const referenceNotProposed = () =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'REFERENCE_NOT_PROPOSED',
    'Não há uma ficha do encarte esperando a sua confirmação.',
  );

export const referenceReviseLimit = (limit: number) =>
  sceneError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'REFERENCE_REVISE_LIMIT',
    `Você já corrigiu ${limit} vezes. Gere assim ou envie outro encarte.`,
    { limit },
  );
