import { randomUUID } from 'crypto';
import { fold } from '../../../shared/text/fold';
import { layerNamedIn } from '../domain/scene-layer-name';
import { BelowRef, LayerAction, LayerTarget } from '../domain/scene-layer.types';
import { SceneElement, SceneElementKind, SceneZones } from '../domain/scene.types';
import { noRoomBelowReply } from '../scene-texts';
import { TurnAttachmentAsset } from './scene-turn-state';

/** Camadas exatas (logo, texto, elemento adicionado): mudam por regra, sem chamar o modelo. */

export interface LayerContext {
  zones: SceneZones;
  widthPx: number;
  heightPx: number;
  elements: SceneElement[];
  attachments: TurnAttachmentAsset[];
}

export type LayerResult =
  | { ok: true; elements: SceneElement[]; changed: string[] }
  | { ok: false; reply: string };

const SIDE_MARGIN = 0.04;
const LOGO_WIDTH = 0.3;
const TEXT_WIDTH = 0.6;
const KIND_LABEL: Record<string, { name: string; article: string; plural: string }> = {
  logo: { name: 'logo', article: 'a', plural: 'uma' },
  text: { name: 'texto', article: 'o', plural: 'um' },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const nextZ = (elements: SceneElement[]): number => Math.max(0, ...elements.map((e) => e.z)) + 1;

function nextName(elements: SceneElement[], kind: SceneElementKind, label: string): string {
  const numbers = elements
    .filter((e) => e.kind === kind)
    .map((e) => Number(e.name.match(/(\d+)$/)?.[1] ?? 0));
  return `${label} ${Math.max(0, ...numbers) + 1}`;
}

/** Altura do elemento em fração da altura da cena. */
function heightFraction(el: SceneElement, ctx: LayerContext): number {
  return (el.w * ctx.widthPx) / el.aspect / ctx.heightPx;
}

/** Procura o alvo pelo id selecionado ou pelo tipo citado; 0 ou 2+ do tipo viram resposta ao cliente. */
function findTarget(
  target: LayerTarget,
  elements: SceneElement[],
): { element: SceneElement } | { reply: string } {
  if ('elementId' in target) {
    const found = elements.find((e) => e.id === target.elementId);
    return found
      ? { element: found }
      : { reply: 'Não encontrei esse elemento na cena. Nada foi alterado.' };
  }
  const same = elements.filter((e) => e.kind === target.kind);
  const label = KIND_LABEL[target.kind];
  if (same.length === 0) {
    return { reply: `Não encontrei ${label.article} ${label.name} na cena. Nada foi alterado.` };
  }
  if (same.length > 1) {
    return {
      reply: `Há mais de ${label.plural} ${label.name}. Selecione na prévia qual quer mudar. Nada foi alterado.`,
    };
  }
  return { element: same[0] };
}

/** Folga entre a base da camada citada e o topo da caixa de baixo, em fração da altura da página (B3). */
const BELOW_GAP = 0.01;

/** Estado de uma aplicação: as camadas criadas antes, na mesma lista, que "embaixo de X" pode citar. */
interface RunState {
  created: Set<string>;
}

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (el: SceneElement, ctx: LayerContext): Box => ({
  x: el.x,
  y: el.y,
  w: el.w,
  h: heightFraction(el, ctx),
});
const overlaps = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

/** A camada citada em "embaixo de X": a criada antes na lista, ou a única do tipo (ou do nome); 0 ou 2+ viram resposta. */
function findBelowRef(
  ref: BelowRef,
  elements: SceneElement[],
  state: RunState,
): { element: SceneElement } | { reply: string } {
  const ofKind = elements.filter((e) => e.kind === ref.kind);
  const fresh = ofKind.filter((e) => state.created.has(e.id));
  if (fresh.length) return { element: fresh[fresh.length - 1] };
  if (ref.kind !== 'generated') return findTarget({ kind: ref.kind }, elements);
  const named = ref.name ? ofKind.filter((e) => layerNamedIn(e, fold(ref.name as string))) : ofKind;
  return named.length === 1
    ? { element: named[0] }
    : { reply: 'Selecione na prévia a camada de referência. Nada foi alterado.' };
}

/**
 * Centro da caixa `w` x `aspect` logo abaixo da base da camada de referência, alinhada pelo lado dela (borda esquerda
 * com a esquerda, centro com o centro, borda direita com a direita), dentro da página e sem sobrepor (B3). `null` quando
 * não há espaço abaixo.
 */
function placeBelow(
  ref: SceneElement,
  size: { w: number; aspect: number },
  ctx: LayerContext,
): [number, number] | null {
  const refBox = boxOf(ref, ctx);
  const h = heightFraction(size as SceneElement, ctx);
  const top = refBox.y + refBox.h / 2 + BELOW_GAP;
  if (top + h > 1) return null;
  const side = ref.x < 1 / 3 ? 'left' : ref.x > 2 / 3 ? 'right' : 'center';
  const aligned =
    side === 'left'
      ? ref.x - ref.w / 2 + size.w / 2
      : side === 'right'
        ? ref.x + ref.w / 2 - size.w / 2
        : ref.x;
  const x = clamp(aligned, size.w / 2, 1 - size.w / 2);
  const y = top + h / 2;
  return overlaps(refBox, { x, y, w: size.w, h }) ? null : [x, y];
}

/** O lugar de uma camada "embaixo de X", ou a resposta ao cliente (referência ausente, ambígua ou sem espaço). */
function belowSpot(
  below: BelowRef,
  size: { w: number; aspect: number },
  input: { ctx: LayerContext; elements: SceneElement[]; state: RunState },
): { at: [number, number] } | { reply: string } {
  const found = findBelowRef(below, input.elements, input.state);
  if ('reply' in found) return found;
  const at = placeBelow(found.element, size, input.ctx);
  return at ? { at } : { reply: noRoomBelowReply(found.element.name) };
}

/** Proporção da logo anexada; 0 quando o arquivo não foi lido (a logo recusa depois). */
function logoAspect(action: Extract<LayerAction, { type: 'add_logo' }>, ctx: LayerContext): number {
  const asset = ctx.attachments.find((a) => a.id === action.assetId);
  return asset?.width && asset.height ? asset.width / asset.height : 0;
}

function logoElement(
  action: Extract<LayerAction, { type: 'add_logo' }>,
  ctx: LayerContext,
  elements: SceneElement[],
  spot?: [number, number],
): SceneElement | null {
  const asset = ctx.attachments.find((a) => a.id === action.assetId);
  if (!asset?.width || !asset.height) return null;
  const aspect = asset.width / asset.height;
  const zone = ctx.zones[action.zone];
  const x =
    action.side === 'left'
      ? SIDE_MARGIN + LOGO_WIDTH / 2
      : action.side === 'right'
        ? 1 - SIDE_MARGIN - LOGO_WIDTH / 2
        : 0.5;
  const draft = { w: LOGO_WIDTH, aspect } as SceneElement;
  const h = heightFraction(draft, ctx);
  return {
    id: randomUUID(),
    kind: 'logo',
    name: nextName(elements, 'logo', 'Logo'),
    x: spot ? spot[0] : x,
    y: spot ? spot[1] : clamp(zone.y + zone.h / 2, h / 2, 1 - h / 2),
    w: LOGO_WIDTH,
    aspect,
    rotation: 0,
    z: nextZ(elements),
    assetId: asset.id,
  };
}

/** Texto em camada no lugar pedido (D-51): `position` (zona e lado) vale como para a logo; sem ela, `placement`. */
function textPosition(
  action: Extract<LayerAction, { type: 'set_text' }>,
  ctx: LayerContext,
  elements: SceneElement[],
): [number, number] {
  const { position } = action;
  if (!position) return textY(action.placement, ctx, elements);
  const zone = ctx.zones[position.zone];
  const x =
    position.side === 'left'
      ? SIDE_MARGIN + TEXT_WIDTH / 2
      : position.side === 'right'
        ? 1 - SIDE_MARGIN - TEXT_WIDTH / 2
        : 0.5;
  return [x, zone.y + zone.h / 2];
}

function textY(placement: string, ctx: LayerContext, elements: SceneElement[]): [number, number] {
  const logo = [...elements].reverse().find((e) => e.kind === 'logo');
  if (placement === 'below-logo' && logo) {
    return [logo.x, Math.min(0.95, logo.y + heightFraction(logo, ctx) / 2 + 0.06)];
  }
  const zone = placement === 'top' ? ctx.zones.header : ctx.zones.footer;
  return [0.5, zone.y + zone.h / 2];
}

function textElements(
  action: Extract<LayerAction, { type: 'set_text' }>,
  input: { ctx: LayerContext; elements: SceneElement[]; state: RunState },
): { elements: SceneElement[]; changed: string } | { reply: string } {
  const { ctx, elements } = input;
  const texts = elements.filter((e) => e.kind === 'text');
  const current = action.elementId
    ? texts.find((e) => e.id === action.elementId)
    : action.replace
      ? texts[texts.length - 1]
      : undefined;
  if (current) {
    return {
      elements: elements.map((e) => (e.id === current.id ? { ...e, text: action.text } : e)),
      changed: current.name,
    };
  }
  const below = action.position?.below;
  const spot = below ? belowSpot(below, { w: TEXT_WIDTH, aspect: 5 }, input) : null;
  if (spot && 'reply' in spot) return spot;
  const [x, y] = (spot && 'at' in spot ? spot.at : null) ?? textPosition(action, ctx, elements);
  const created: SceneElement = {
    id: randomUUID(),
    kind: 'text',
    name: nextName(elements, 'text', 'Texto'),
    x,
    y,
    w: TEXT_WIDTH,
    aspect: 5,
    rotation: 0,
    z: nextZ(elements),
    text: action.text,
    fontFamily: 'Georgia',
    fontSize: 7,
    color: '#ffffff',
  };
  return { elements: [...elements, created], changed: created.name };
}

function moveX(el: SceneElement, side: 'left' | 'right' | 'toggle'): number {
  if (side === 'toggle') return 1 - el.x;
  return side === 'left' ? Math.min(el.x, 1 - el.x) : Math.max(el.x, 1 - el.x);
}

function resized(el: SceneElement, direction: 'bigger' | 'smaller'): SceneElement {
  const factor = direction === 'bigger' ? 1.25 : 0.8;
  return el.kind === 'text'
    ? { ...el, fontSize: clamp((el.fontSize ?? 7) * factor, 2, 20) }
    : { ...el, w: clamp(el.w * factor, 0.04, 0.9) };
}

function applyOne(
  action: LayerAction,
  input: { ctx: LayerContext; elements: SceneElement[]; state: RunState },
): LayerResult {
  const { ctx, elements } = input;
  if (action.type === 'add_logo') {
    const draft = { w: LOGO_WIDTH, aspect: logoAspect(action, ctx) };
    const spot = action.below && draft.aspect ? belowSpot(action.below, draft, input) : undefined;
    if (spot && 'reply' in spot) return { ok: false, reply: spot.reply };
    const logo = logoElement(action, ctx, elements, spot && 'at' in spot ? spot.at : undefined);
    return logo
      ? { ok: true, elements: [...elements, logo], changed: [logo.name] }
      : { ok: false, reply: 'Não consegui ler o logo enviado. Envie o arquivo de novo.' };
  }
  if (action.type === 'set_text') {
    const result = textElements(action, input);
    if ('reply' in result) return { ok: false, reply: result.reply };
    return { ok: true, elements: result.elements, changed: [result.changed] };
  }
  const found = findTarget(action.target, elements);
  if ('reply' in found) return { ok: false, reply: found.reply };
  const { element } = found;
  if (action.type === 'remove') {
    return {
      ok: true,
      elements: elements.filter((e) => e.id !== element.id),
      changed: [element.name],
    };
  }
  const next =
    action.type === 'move'
      ? { ...element, x: moveX(element, action.side) }
      : resized(element, action.direction);
  return {
    ok: true,
    elements: elements.map((e) => (e.id === element.id ? next : e)),
    changed: [element.name],
  };
}

/**
 * Aplica as ações em ordem. A primeira que não puder (alvo ausente, ambíguo, logo ilegível) devolve a
 * resposta para o cliente e nada é alterado.
 */
export function applyLayerActions(actions: LayerAction[], ctx: LayerContext): LayerResult {
  let elements = structuredClone(ctx.elements);
  const changed: string[] = [];
  const state: RunState = { created: new Set() };
  for (const action of actions) {
    const result = applyOne(action, { ctx, elements, state });
    if (result.ok === false) return result;
    const known = new Set(elements.map((e) => e.id));
    for (const e of result.elements) if (!known.has(e.id)) state.created.add(e.id);
    elements = result.elements;
    changed.push(...result.changed);
  }
  return { ok: true, elements, changed };
}
