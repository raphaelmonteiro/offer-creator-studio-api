import { MaskShape, Rect, SceneZoneName } from './scene.types';
import {
  additionSubject,
  citesImageItem,
  detectZone,
  fold,
  LayerKind,
  layerKindIn,
  logoPositionIn,
  LogoPosition,
  mentionsMove,
  mentionsRemove,
  mentionsResize,
  parseText,
  ParsedText,
  Side,
  sideIn,
  wantsAddition,
} from './scene-request-text';

/** Elemento selecionado na prévia como alvo do pedido. */
export interface ClassifierTargetElement {
  id: string;
  kind: 'logo' | 'text' | 'generated' | 'sun' | 'cloud';
}

export interface ClassifierInput {
  hasReadyVersion: boolean;
  content: string;
  region?: Rect;
  mask?: MaskShape;
  zone?: SceneZoneName;
  targetElement?: ClassifierTargetElement;
  /** Logo já enviado pelo clipe (o chat só anexa logo). */
  attachments?: Array<{ assetId: string }>;
  confirmGlobal?: boolean;
}

/** Onde uma edição local acontece. */
export type LocalTarget =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'mask'; mask: MaskShape }
  | { kind: 'zone'; zone: SceneZoneName }
  | { kind: 'element'; elementId: string };

/** Mudança exata numa camada (logo, texto, elemento adicionado), sem IA. */
export type LayerAction =
  | ({ type: 'add_logo'; assetId: string } & LogoPosition)
  | ({ type: 'set_text' } & ParsedText)
  | { type: 'move'; target: LayerTarget; side: Side }
  | { type: 'resize'; target: LayerTarget; direction: 'bigger' | 'smaller' }
  | { type: 'remove'; target: LayerTarget };

/** Elemento escolhido por seleção (`elementId`) ou pelo tipo citado no texto (`kind`). */
export type LayerTarget = { elementId: string } | { kind: LayerKind };

export type SceneClassification =
  | { operation: 'generate' }
  | { operation: 'set_layer'; actions: LayerAction[] }
  | { operation: 'local_edit'; target: LocalTarget; instruction: string; remove: boolean }
  | { operation: 'add_element'; subject: string; target: LocalTarget | null }
  | { operation: 'global_regenerate'; instruction: string }
  | { operation: 'needs_confirmation_global' }
  | { operation: 'move_unavailable' }
  | { operation: 'needs_region'; reason: 'item' | 'layer_visual' };

type Rule = (input: ClassifierInput, folded: string) => SceneClassification | null;

const layerOp = (...actions: LayerAction[]): SceneClassification => ({
  operation: 'set_layer',
  actions,
});

/** Alvo explícito da mensagem: forma marcada, retângulo ou zona (campo ou citada no texto). */
function markedTarget(input: ClassifierInput): LocalTarget | null {
  if (input.mask) return { kind: 'mask', mask: input.mask };
  if (input.region) return { kind: 'rect', rect: input.region };
  const zone = input.zone ?? detectZone(input.content);
  return zone ? { kind: 'zone', zone } : null;
}

const ruleGenerate: Rule = (input) => (input.hasReadyVersion ? null : { operation: 'generate' });

/** Anexo de logo (com texto entre aspas junto, se houver): camadas exatas. */
const ruleLogoAttachment: Rule = (input, folded) => {
  const assetId = input.attachments?.[0]?.assetId;
  if (!assetId) return null;
  const actions: LayerAction[] = [{ type: 'add_logo', assetId, ...logoPositionIn(folded) }];
  const text = parseText(input.content);
  if (text) actions.push({ type: 'set_text', ...text });
  return layerOp(...actions);
};

const ruleQuotedText: Rule = (input) => {
  const text = parseText(input.content);
  return text ? layerOp({ type: 'set_text', ...text }) : null;
};

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

/** Elemento selecionado: mover/redimensionar/tirar é camada; pedido visual vai ao modelo só se for `generated`. */
const ruleSelectedElement: Rule = (input, folded) => {
  const element = input.targetElement;
  if (!element) return null;
  const layer = selectedLayerAction(element, folded);
  if (layer) return layer;
  if (element.kind !== 'logo' && element.kind !== 'text') {
    return {
      operation: 'local_edit',
      target: { kind: 'element', elementId: element.id },
      instruction: input.content,
      remove: false,
    };
  }
  return { operation: 'needs_region', reason: 'layer_visual' };
};

/** Logo ou texto citados pelo nome, sem seleção: mover, redimensionar e tirar são camadas. */
const ruleNamedLayer: Rule = (input, folded) => {
  const kind = layerKindIn(folded);
  if (!kind) return null;
  const target: LayerTarget = { kind };
  if (mentionsRemove(folded)) return layerOp({ type: 'remove', target });
  if (mentionsMove(folded)) return layerOp({ type: 'move', target, side: sideIn(folded) });
  const direction = mentionsResize(folded);
  if (direction) return layerOp({ type: 'resize', target, direction });
  // Pedido visual sobre logo ou texto: com área marcada é uma edição da área; sem ela, logo e texto não passam pelo modelo.
  return markedTarget(input) ? null : { operation: 'needs_region', reason: 'layer_visual' };
};

/** Mover um item da imagem (sol, nuvem...) não existe sem refazê-lo. */
const ruleMoveUnavailable: Rule = (_input, folded) =>
  mentionsMove(folded) ? { operation: 'move_unavailable' } : null;

const ruleAddElement: Rule = (input, folded) => {
  const hasArea = Boolean(input.region ?? input.mask ?? input.zone);
  if (!wantsAddition(folded, hasArea)) return null;
  return {
    operation: 'add_element',
    subject: additionSubject(input.content),
    target: markedTarget(input),
  };
};

const ruleMarkedEdit: Rule = (input, folded) => {
  const target = markedTarget(input);
  if (!target) return null;
  return {
    operation: 'local_edit',
    target,
    instruction: input.content,
    remove: mentionsRemove(folded),
  };
};

const ruleConfirmedGlobal: Rule = (input) =>
  input.confirmGlobal ? { operation: 'global_regenerate', instruction: input.content } : null;

/** Sem item citado e sem área: ajuste geral (pede confirmação); citando um item sem área, pede a marcação. */
const ruleUnmarked: Rule = (_input, folded) =>
  citesImageItem(folded)
    ? { operation: 'needs_region', reason: 'item' }
    : { operation: 'needs_confirmation_global' };

const RULES: Rule[] = [
  ruleGenerate,
  ruleLogoAttachment,
  ruleQuotedText,
  ruleSelectedElement,
  ruleNamedLayer,
  ruleMoveUnavailable,
  ruleAddElement,
  ruleMarkedEdit,
  ruleConfirmedGlobal,
  ruleUnmarked,
];

/**
 * Classifica a mensagem por regra, sem chamada de modelo. A primeira regra que casa decide:
 * sem versão → `generate`; anexo de logo e texto entre aspas → camadas exatas; elemento
 * selecionado; logo/texto citados; mover item da imagem → indisponível; "adicionar"; marcação ou zona
 * → edição local; confirmação do ajuste geral; o resto pede confirmação global ou a marcação da área.
 */
export function classifySceneRequest(input: ClassifierInput): SceneClassification {
  const folded = fold(input.content);
  for (const rule of RULES) {
    const result = rule(input, folded);
    if (result) return result;
  }
  return { operation: 'needs_confirmation_global' };
}
