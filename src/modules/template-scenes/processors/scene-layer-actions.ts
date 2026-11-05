import { randomUUID } from 'crypto';
import { LayerAction, LayerTarget } from '../domain/scene-operation.classifier';
import { SceneElement, SceneElementKind, SceneZones } from '../domain/scene.types';
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

function logoElement(
  action: Extract<LayerAction, { type: 'add_logo' }>,
  ctx: LayerContext,
  elements: SceneElement[],
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
    x,
    y: clamp(zone.y + zone.h / 2, h / 2, 1 - h / 2),
    w: LOGO_WIDTH,
    aspect,
    rotation: 0,
    z: nextZ(elements),
    assetId: asset.id,
  };
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
  ctx: LayerContext,
  elements: SceneElement[],
): { elements: SceneElement[]; changed: string } {
  const texts = elements.filter((e) => e.kind === 'text');
  const current = action.replace ? texts[texts.length - 1] : undefined;
  if (current) {
    return {
      elements: elements.map((e) => (e.id === current.id ? { ...e, text: action.text } : e)),
      changed: current.name,
    };
  }
  const [x, y] = textY(action.placement, ctx, elements);
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

function applyOne(action: LayerAction, ctx: LayerContext, elements: SceneElement[]): LayerResult {
  if (action.type === 'add_logo') {
    const logo = logoElement(action, ctx, elements);
    return logo
      ? { ok: true, elements: [...elements, logo], changed: [logo.name] }
      : { ok: false, reply: 'Não consegui ler o logo enviado. Envie o arquivo de novo.' };
  }
  if (action.type === 'set_text') {
    const result = textElements(action, ctx, elements);
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
  for (const action of actions) {
    const result = applyOne(action, ctx, elements);
    if (result.ok === false) return result;
    elements = result.elements;
    changed.push(...result.changed);
  }
  return { ok: true, elements, changed };
}
