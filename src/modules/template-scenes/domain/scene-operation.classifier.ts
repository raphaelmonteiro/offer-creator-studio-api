import { MaskShape, Rect, SceneZoneName } from './scene.types';
import { fold } from '../../../shared/text/fold';
import { LayerAction, LayerTarget } from './scene-layer.types';
import {
  mentionsIntegrate,
  mentionsMove,
  mentionsRemove,
  mentionsResize,
  sideIn,
} from './scene-request-text';
import { logoPositionIn, parseText } from './scene-request-parse';

/** Elemento selecionado na prévia como alvo do pedido. */
export interface ClassifierTargetElement {
  id: string;
  kind: 'logo' | 'text' | 'generated' | 'sun' | 'cloud';
}

export interface ClassifierInput {
  hasReadyVersion: boolean;
  content: string;
  targetElement?: ClassifierTargetElement;
  /** Logo já enviado pelo clipe (o chat só anexa logo). */
  attachments?: Array<{ assetId: string }>;
}

/** Onde uma edição local acontece. */
export type LocalTarget =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'mask'; mask: MaskShape }
  | { kind: 'zone'; zone: SceneZoneName; from?: 'field' | 'text' }
  | { kind: 'element'; elementId: string };

export type SceneClassification =
  | { operation: 'generate' }
  | { operation: 'set_layer'; actions: LayerAction[] }
  | {
      operation: 'local_edit';
      target: LocalTarget;
      /** A mensagem do cliente, sempre: a visão e a resposta partem dela. */
      instruction: string;
      remove: boolean;
      /** Frase para o modelo de imagem, vinda da intenção (D-19); sem ela vale `instruction`. */
      imagePrompt?: string;
      /** O objeto nomeado; `null` só com pronome ("remove isso"). */
      object?: string | null;
      /** Pede integrar uma camada ao fundo; o planner acha a camada (`integrateLayer`). */
      integrate?: boolean;
      integrateLayer?: { elementId: string; name: string };
    }
  | { operation: 'add_element'; subject: string; target: LocalTarget | null }
  | { operation: 'global_regenerate'; instruction: string }
  | { operation: 'new_image'; instruction: string }
  | { operation: 'needs_confirmation_global' }
  | { operation: 'needs_confirmation_new_image' }
  | { operation: 'needs_confirmation_edit' }
  | { operation: 'move_unavailable' }
  | { operation: 'needs_region'; reason: NeedsRegionReason; subject?: string };

/**
 * `item`: cita um item sem área; `layer_visual`: pedido visual sobre logo ou texto; `place`: "no lugar de
 * X"; `choose_layer`: mais de uma camada possível ao integrar; `select_layer`: a camada citada não se
 * resolve; `not_understood`: o modelo de intenção falhou; `integrate`: interno, resolvido por
 * `resolveIntegration` antes de responder.
 */
export type NeedsRegionReason =
  | 'item'
  | 'layer_visual'
  | 'place'
  | 'choose_layer'
  | 'select_layer'
  | 'not_understood'
  | 'integrate';

const layerOp = (...actions: LayerAction[]): SceneClassification => ({
  operation: 'set_layer',
  actions,
});

/** Anexo de logo (com texto entre aspas junto, se houver): camadas exatas. */
function logoAttachment(input: ClassifierInput, folded: string): SceneClassification | null {
  const assetId = input.attachments?.[0]?.assetId;
  if (!assetId) return null;
  const actions: LayerAction[] = [{ type: 'add_logo', assetId, ...logoPositionIn(folded) }];
  const text = parseText(input.content);
  if (text) actions.push({ type: 'set_text', ...text });
  return layerOp(...actions);
}

function selectedLayerAction(
  element: ClassifierTargetElement,
  folded: string,
): SceneClassification | null {
  const target: LayerTarget = { elementId: element.id };
  if (mentionsRemove(folded)) return layerOp({ type: 'remove', target });
  if (mentionsMove(folded) || /\b(esquerda|direita)\b/.test(folded)) {
    return layerOp({ type: 'move', target, side: sideIn(folded) });
  }
  const direction = mentionsResize(folded);
  return direction ? layerOp({ type: 'resize', target, direction }) : null;
}

/**
 * Texto exato (PV-50, correção 6): camada sem modelo, antes do elemento selecionado. Com um texto
 * selecionado, troca esse texto; com outro elemento, cria um texto novo.
 */
function exactText(input: ClassifierInput): SceneClassification | null {
  const text = parseText(input.content);
  const element = input.targetElement;
  if (!text || !element) return null;
  if (element.kind === 'text') {
    return layerOp({ type: 'set_text', ...text, replace: true, elementId: element.id });
  }
  return layerOp({ type: 'set_text', ...text, replace: false });
}

/**
 * Elemento selecionado: o alvo é ele. Mover, redimensionar e tirar (verbos da lista curta) são camada;
 * o resto é pedido visual, que só o elemento `generated` aceita (`local_edit` na caixa dele).
 */
function selectedElement(input: ClassifierInput, folded: string): SceneClassification | null {
  const element = input.targetElement;
  if (!element) return null;
  const integrates = element.kind === 'generated' && mentionsIntegrate(folded);
  const layer = integrates ? null : selectedLayerAction(element, folded);
  if (layer) return layer;
  if (element.kind !== 'logo' && element.kind !== 'text') {
    return {
      operation: 'local_edit',
      target: { kind: 'element', elementId: element.id },
      instruction: input.content,
      remove: false,
      ...(integrates ? { integrate: true } : {}),
    };
  }
  return { operation: 'needs_region', reason: 'layer_visual' };
}

/**
 * Classifica a mensagem pelos sinais estruturados, sem texto livre e sem modelo (D-19): sem versão
 * pronta → `generate`; anexo de logo → camadas exatas; texto exato com elemento selecionado → camada; elemento selecionado → o alvo é ele. Devolve
 * `null` quando a intenção depende do texto: aí roda o modelo de intenção (`planFromIntent`). A
 * confirmação segue o plano guardado na pergunta e nunca passa por aqui.
 */
export function classifySceneRequest(input: ClassifierInput): SceneClassification | null {
  if (!input.hasReadyVersion) return { operation: 'generate' };
  const folded = fold(input.content);
  return logoAttachment(input, folded) ?? exactText(input) ?? selectedElement(input, folded);
}
