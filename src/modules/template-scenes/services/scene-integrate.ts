import { fold, mentionsIntegrate } from '../domain/scene-request-text';
import { elementRect } from '../domain/scene-element-rect';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { RegionSpec, rasterizeRegion } from '../domain/scene-shapes';
import { Rect, SceneElement, SceneZones } from '../domain/scene.types';

/** Integrar uma camada ao fundo (correção 5): o planner conhece as camadas e escolhe o alvo. */

const STOP_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'uma', 'um']);
const RASTER_WIDTH = 256;
/** A camada conta como "na área" se pelo menos metade da caixa dela está dentro da marcação. */
const MIN_INSIDE_RATIO = 0.5;

export interface IntegrateScene {
  widthPx: number;
  heightPx: number;
  zones: SceneZones;
}

type LocalEditPlan = Extract<SceneClassification, { operation: 'local_edit' }>;

const words = (name: string): string[] =>
  fold(name)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

/** O texto do pedido cita o nome da camada (alguma palavra significativa dele)? */
function namedIn(layer: SceneElement, folded: string): boolean {
  return words(layer.name).some((word) => new RegExp(`\\b${word}`).test(folded));
}

/** Fração da caixa da camada que cai dentro da forma marcada. */
async function insideRatio(
  layer: SceneElement,
  spec: RegionSpec,
  scene: IntegrateScene,
): Promise<number> {
  const height = Math.max(1, Math.round((RASTER_WIDTH * scene.heightPx) / scene.widthPx));
  const shape = await rasterizeRegion(spec, RASTER_WIDTH, height, scene.zones);
  const box: Rect = elementRect(layer, scene);
  const x0 = Math.floor(box.x * RASTER_WIDTH);
  const x1 = Math.max(x0 + 1, Math.ceil((box.x + box.w) * RASTER_WIDTH));
  const y0 = Math.floor(box.y * height);
  const y1 = Math.max(y0 + 1, Math.ceil((box.y + box.h) * height));
  let inside = 0;
  let total = 0;
  for (let y = y0; y < Math.min(y1, height); y += 1) {
    for (let x = x0; x < Math.min(x1, RASTER_WIDTH); x += 1) {
      total += 1;
      if (shape.data[y * RASTER_WIDTH + x]) inside += 1;
    }
  }
  return total === 0 ? 0 : inside / total;
}

const layerRef = (layer: SceneElement) => ({ elementId: layer.id, name: layer.name });

/** Edição local da caixa da camada (sem marcação): o alvo passa a ser a própria camada. */
function onLayerBox(content: string, layer: SceneElement): LocalEditPlan {
  return {
    operation: 'local_edit',
    target: { kind: 'element', elementId: layer.id },
    instruction: content,
    remove: false,
    integrate: true,
    integrateLayer: layerRef(layer),
  };
}

/** Com área marcada: as camadas com metade da caixa dentro; com mais de uma, o nome citado desempata. */
async function resolveInArea(
  plan: LocalEditPlan,
  layers: SceneElement[],
  ctx: { spec: RegionSpec | null; scene: IntegrateScene; folded: string },
): Promise<SceneClassification> {
  if (!ctx.spec) return plan;
  const inside: SceneElement[] = [];
  for (const layer of layers) {
    if ((await insideRatio(layer, ctx.spec, ctx.scene)) >= MIN_INSIDE_RATIO) inside.push(layer);
  }
  if (inside.length === 0) return { ...plan, integrate: false };
  const named = inside.length === 1 ? inside : inside.filter((l) => namedIn(l, ctx.folded));
  if (named.length === 1) return { ...plan, integrateLayer: layerRef(named[0]) };
  return { operation: 'needs_region', reason: 'choose_layer' };
}

function specOf(plan: LocalEditPlan): RegionSpec | null {
  const target = plan.target;
  if (target.kind === 'rect') return { kind: 'rect', rect: target.rect };
  if (target.kind === 'mask') return target.mask;
  if (target.kind === 'zone') return { kind: 'zone', zone: target.zone };
  return null;
}

/**
 * Acha a camada `generated` a integrar. Selecionada: ela. Com área: as camadas com pelo menos metade
 * da caixa dentro dela (uma só é o alvo; duas ou mais, o nome citado desempata, senão pede para
 * selecionar; nenhuma: edição local comum). Sem marcação: uma única camada cujo nome o texto cita,
 * com a caixa dela; senão a resposta pede a marcação. Logo e texto nunca entram.
 */
export async function resolveIntegration(
  classification: SceneClassification,
  input: { content: string; layers: SceneElement[]; scene: IntegrateScene },
): Promise<SceneClassification> {
  const folded = fold(input.content);
  const layers = input.layers.filter((layer) => layer.kind === 'generated');
  if (classification.operation === 'needs_region' && classification.reason === 'item') {
    if (!mentionsIntegrate(folded)) return classification;
    const named = layers.filter((layer) => namedIn(layer, folded));
    return named.length === 1 ? onLayerBox(input.content, named[0]) : classification;
  }
  if (classification.operation !== 'local_edit' || !classification.integrate) return classification;
  if (classification.target.kind === 'element') {
    const { elementId } = classification.target;
    const layer = layers.find((candidate) => candidate.id === elementId);
    return layer ? { ...classification, integrateLayer: layerRef(layer) } : classification;
  }
  return resolveInArea(classification, layers, {
    spec: specOf(classification),
    scene: input.scene,
    folded,
  });
}
