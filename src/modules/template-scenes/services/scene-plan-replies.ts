import { SceneClassification } from '../domain/scene-operation.classifier';
import { SceneVersionOperation } from '../domain/scene.types';
import {
  CHOOSE_LAYER_REPLY,
  EDIT_CONFIRM_REPLY,
  GLOBAL_CONFIRM_REPLY,
  MOVE_UNAVAILABLE_REPLY,
  NEEDS_REGION_LAYER_REPLY,
  NEEDS_REGION_REPLY,
  needsPlaceReply,
  NEW_IMAGE_CONFIRM_REPLY,
  NOT_UNDERSTOOD_REPLY,
  SELECT_LAYER_REPLY,
} from '../scene-texts';

/** Operação gravada na versão (as respostas imediatas usam a mais próxima do pedido). */
export const OPERATION_OF: Record<SceneClassification['operation'], SceneVersionOperation> = {
  generate: 'generate',
  global_regenerate: 'generate',
  new_image: 'generate',
  needs_confirmation_new_image: 'generate',
  needs_confirmation_global: 'generate',
  needs_confirmation_edit: 'local_edit',
  local_edit: 'local_edit',
  needs_region: 'local_edit',
  move_unavailable: 'local_edit',
  add_element: 'add_element',
  set_layer: 'set_layer',
};

/** Operações respondidas na hora, sem job (versão `rejected`). */
export const REPLY_OPERATIONS: ReadonlySet<SceneClassification['operation']> = new Set([
  'needs_region',
  'move_unavailable',
  'needs_confirmation_global',
  'needs_confirmation_new_image',
  'needs_confirmation_edit',
]);

const NEEDS_REGION_REPLIES: Record<string, string> = {
  layer_visual: NEEDS_REGION_LAYER_REPLY,
  choose_layer: CHOOSE_LAYER_REPLY,
  select_layer: SELECT_LAYER_REPLY,
  not_understood: NOT_UNDERSTOOD_REPLY,
};

/** Resposta do assistente a uma operação que não vira job. */
export function replyFor(classification: SceneClassification): string {
  switch (classification.operation) {
    case 'move_unavailable':
      return MOVE_UNAVAILABLE_REPLY;
    case 'needs_confirmation_global':
      return GLOBAL_CONFIRM_REPLY;
    case 'needs_confirmation_new_image':
      return NEW_IMAGE_CONFIRM_REPLY;
    case 'needs_confirmation_edit':
      return EDIT_CONFIRM_REPLY;
    case 'needs_region':
      return classification.reason === 'place'
        ? needsPlaceReply(classification.subject ?? '')
        : (NEEDS_REGION_REPLIES[classification.reason] ?? NEEDS_REGION_REPLY);
    default:
      return NEEDS_REGION_REPLY;
  }
}
