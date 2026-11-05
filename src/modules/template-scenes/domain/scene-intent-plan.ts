import { SceneIntent } from './scene-intent';
import { layerNamedIn } from './scene-layer-name';
import {
  LayerAction,
  LayerTarget,
  LocalTarget,
  SceneClassification,
} from './scene-operation.classifier';
import { fold } from './scene-request-text';
import { SceneElement } from './scene.types';

/** O que o código sabe da mensagem além da intenção: a marcação e as camadas da imagem atual. */
export interface IntentPlanInput {
  /** A mensagem do cliente, literal. */
  content: string;
  /** Área marcada (retângulo, forma ou campo `zone`); `null` sem marcação. Com marcação, ela é sempre o alvo. */
  marked: LocalTarget | null;
  /** Camadas da imagem atual, para resolver a camada `generated` citada. */
  layers: SceneElement[];
}

type Plan = SceneClassification;
const NEEDS_ITEM: Plan = { operation: 'needs_region', reason: 'item' };

/** Edição na área marcada com a mensagem do cliente, sem a frase do modelo (a marcação manda). */
function markedEdit(input: IntentPlanInput, target: LocalTarget): Plan {
  return { operation: 'local_edit', target, instruction: input.content, remove: false };
}

/** `edit` e `remove`: sem marcação, só a zona citada como lugar vale; senão pede a área. */
function editPlan(intent: SceneIntent, input: IntentPlanInput, remove: boolean): Plan {
  const target: LocalTarget | null =
    input.marked ?? (intent.zone ? { kind: 'zone', zone: intent.zone, from: 'text' } : null);
  if (!target) return NEEDS_ITEM;
  return {
    operation: 'local_edit',
    target,
    instruction: input.content,
    remove,
    ...(intent.imagePrompt ? { imagePrompt: intent.imagePrompt } : {}),
    object: intent.object,
  };
}

/** `add_element`: "no lugar de X" sem área não tem posição a inventar (`place`); com zona, o centro dela. */
function addPlan(intent: SceneIntent, input: IntentPlanInput): Plan {
  const subject = intent.subject ?? input.content;
  if (input.marked) return { operation: 'add_element', subject, target: input.marked };
  if (intent.relativePlace) return { operation: 'needs_region', reason: 'place', subject };
  const target: LocalTarget | null = intent.zone
    ? { kind: 'zone', zone: intent.zone, from: 'text' }
    : null;
  return { operation: 'add_element', subject, target };
}

/** `integrate`: o alvo (selecionado, nome citado, área) é resolvido por `resolveIntegration`. */
function integratePlan(intent: SceneIntent, input: IntentPlanInput): Plan {
  if (!input.marked) return { operation: 'needs_region', reason: 'integrate' };
  return {
    operation: 'local_edit',
    target: input.marked,
    instruction: input.content,
    remove: false,
    integrate: true,
    ...(intent.imagePrompt ? { imagePrompt: intent.imagePrompt } : {}),
    object: intent.object,
  };
}

/** Camada citada: logo e texto pelo tipo; a `generated` pelo nome, se só uma serve (senão pede a seleção). */
function layerTargetOf(intent: SceneIntent, input: IntentPlanInput): LayerTarget | null {
  const layer = intent.layer;
  if (layer?.kind === 'logo' || layer?.kind === 'text') return { kind: layer.kind };
  const generated = input.layers.filter((element) => element.kind === 'generated');
  const named = layer?.name
    ? generated.filter((element) => layerNamedIn(element, fold(layer.name)))
    : generated;
  return named.length === 1 ? { elementId: named[0].id } : null;
}

function layerPlan(intent: SceneIntent, input: IntentPlanInput): Plan {
  const target = layerTargetOf(intent, input);
  if (!target) return { operation: 'needs_region', reason: 'select_layer' };
  const layer = intent.layer;
  let action: LayerAction;
  if (intent.action === 'layer_move') {
    action = { type: 'move', target, side: layer?.side ?? 'toggle' };
  } else if (intent.action === 'layer_resize') {
    action = { type: 'resize', target, direction: layer?.direction ?? 'bigger' };
  } else {
    action = { type: 'remove', target };
  }
  return { operation: 'set_layer', actions: [action] };
}

function textPlan(intent: SceneIntent): Plan {
  const text = intent.text;
  return {
    operation: 'set_layer',
    actions: [
      {
        type: 'set_text',
        text: text.value,
        placement: text.placement,
        replace: intent.layer?.kind === 'text',
      },
    ],
  };
}

/**
 * Do modelo ao plano (D-19), função pura. A intenção do modelo já passou pelo schema fechado; aqui o
 * código decide o efeito. Com marcação, o alvo é sempre a marcação (a zona do modelo é ignorada) e
 * ajuste geral, imagem nova e "pedir a área" viram edição local da área. Sem marcação, o ajuste geral e a
 * imagem nova pedem confirmação, e citar um item sem lugar pede a área.
 */
export function planFromIntent(intent: SceneIntent, input: IntentPlanInput): Plan {
  switch (intent.action) {
    case 'edit':
      return editPlan(intent, input, false);
    case 'remove':
      return editPlan(intent, input, true);
    case 'add_element':
      return addPlan(intent, input);
    case 'integrate':
      return integratePlan(intent, input);
    case 'global_adjust':
      return input.marked
        ? markedEdit(input, input.marked)
        : { operation: 'needs_confirmation_global' };
    case 'new_image':
      return input.marked
        ? markedEdit(input, input.marked)
        : { operation: 'needs_confirmation_new_image' };
    case 'move_item':
      return { operation: 'move_unavailable' };
    case 'set_text':
      return textPlan(intent);
    case 'ask_region':
      return input.marked ? markedEdit(input, input.marked) : NEEDS_ITEM;
    default:
      return layerPlan(intent, input);
  }
}
