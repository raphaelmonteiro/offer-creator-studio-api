import { fold } from '../../../shared/text/fold';
import { DirectorLayerOp } from './scene-director-schema';
import { layerNamedIn } from './scene-layer-name';
import { LayerAction, LayerTarget, LogoPosition } from './scene-layer.types';
import { SceneElement } from './scene.types';

/**
 * `layer_ops` do Diretor viram `LayerAction` (as ações exatas de `applyLayerActions`), sem chamar o modelo de
 * imagem. O texto exato já foi conferido como literal da mensagem (validação 2). O elemento selecionado
 * (`targetElementId`) é só uma dica de qual camada o cliente quer.
 */

export interface LayerOpsInput {
  /** Camadas da imagem atual. */
  elements: SceneElement[];
  /** A logo anexada à mensagem, se houver. */
  attachmentId: string | null;
  /** Elemento selecionado na prévia, enviado como dica. */
  hintElementId: string | null;
}

export type LayerOpsResult = { ok: true; actions: LayerAction[] } | { ok: false; reply: string };

const SELECT_LAYER = 'Selecione na prévia a camada que quer mudar. Nada foi alterado.';
const NO_ATTACHMENT = 'Envie a logo pelo clipe e diga onde colocá-la. Nada foi alterado.';

/** O alvo da operação: logo e texto pelo tipo (ou a dica, se for do tipo), camada antiga pelo nome ou pela dica. */
function targetOf(op: DirectorLayerOp, input: LayerOpsInput): LayerTarget | null {
  const layer = op.layer;
  if (!layer) return null;
  const hint = input.elements.find((element) => element.id === input.hintElementId);
  if (layer.kind === 'logo' || layer.kind === 'text') {
    return hint?.kind === layer.kind ? { elementId: hint.id } : { kind: layer.kind };
  }
  const generated = input.elements.filter((element) => element.kind === 'generated');
  const named = layer.name
    ? generated.filter((element) => layerNamedIn(element, fold(layer.name as string)))
    : generated;
  if (named.length === 1) return { elementId: named[0].id };
  return hint?.kind === 'generated' ? { elementId: hint.id } : null;
}

function actionOf(op: DirectorLayerOp, input: LayerOpsInput): LayerAction | { reply: string } {
  if (op.op === 'add_logo') {
    if (!input.attachmentId) return { reply: NO_ATTACHMENT };
    const position = op.position as NonNullable<DirectorLayerOp['position']>;
    return {
      type: 'add_logo',
      assetId: input.attachmentId,
      side: position.side,
      zone: position.zone,
    };
  }
  if (op.op === 'set_text') {
    const text = op.text as NonNullable<DirectorLayerOp['text']>;
    const hint = input.elements.find((element) => element.id === input.hintElementId);
    const replacing = op.replace || op.layer?.kind === 'text';
    return {
      type: 'set_text',
      text: text.value,
      placement: text.placement,
      replace: replacing,
      // D-51: zona e lado valem também para texto em camada, como para a logo (defeito c).
      ...(op.position ? { position: op.position as LogoPosition } : {}),
      ...(replacing && hint?.kind === 'text' ? { elementId: hint.id } : {}),
    };
  }
  const target = targetOf(op, input);
  if (!target) return { reply: SELECT_LAYER };
  if (op.op === 'remove') return { type: 'remove', target };
  if (op.op === 'resize') {
    return { type: 'resize', target, direction: op.layer?.direction ?? 'bigger' };
  }
  return { type: 'move', target, side: op.layer?.side ?? 'toggle' };
}

/** Converte as operações em ações; a primeira que não der devolve a resposta ao cliente e nada é alterado. */
export function layerOpsToActions(ops: DirectorLayerOp[], input: LayerOpsInput): LayerOpsResult {
  const actions: LayerAction[] = [];
  for (const op of ops) {
    const action = actionOf(op, input);
    if ('reply' in action) return { ok: false, reply: action.reply };
    actions.push(action);
  }
  return { ok: true, actions };
}
