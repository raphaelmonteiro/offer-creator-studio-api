import { fold } from '../../../shared/text/fold';
import { layerNamedIn } from '../domain/scene-layer-name';
import { elementRect } from '../domain/scene-element-rect';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { RegionSpec, rasterizeRegion } from '../domain/scene-shapes';
import { Rect, SceneElement, SceneZones } from '../domain/scene.types';

/** Integrar uma camada ao fundo (correção 5): o planner conhece as camadas e escolhe o alvo. */

const RASTER_WIDTH = 256;
/** A camada conta como "na área" se pelo menos metade da caixa dela está dentro da marcação. */
const MIN_INSIDE_RATIO = 0.5;

export interface IntegrateScene {
  widthPx: number;
  heightPx: number;
  zones: SceneZones;
}

type LocalEditPlan = Extract<SceneClassification, { operation: 'local_edit' }>;

const namedIn = (layer: SceneElement, folded: string): boolean => layerNamedIn(layer, folded);

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

/** Com área marcada e sem nome citado: as camadas com metade da caixa dentro; mais de uma pede a escolha. */
async function resolveInArea(
  plan: LocalEditPlan,
  layers: SceneElement[],
  ctx: { spec: RegionSpec | null; scene: IntegrateScene },
): Promise<SceneClassification> {
  if (!ctx.spec) return plan;
  const inside: SceneElement[] = [];
  for (const layer of layers) {
    if ((await insideRatio(layer, ctx.spec, ctx.scene)) >= MIN_INSIDE_RATIO) inside.push(layer);
  }
  if (inside.length === 0) return { ...plan, integrate: false };
  if (inside.length === 1) return { ...plan, integrateLayer: layerRef(inside[0]) };
  return CHOOSE_LAYER;
}

function specOf(plan: LocalEditPlan): RegionSpec | null {
  const target = plan.target;
  if (target.kind === 'rect') return { kind: 'rect', rect: target.rect };
  if (target.kind === 'mask') return target.mask;
  if (target.kind === 'zone') return { kind: 'zone', zone: target.zone };
  return null;
}

const CHOOSE_LAYER: SceneClassification = { operation: 'needs_region', reason: 'choose_layer' };

/** Camadas que o nome citado aponta: uma só é o alvo, duas ou mais pedem a escolha. */
function namedLayers(layers: SceneElement[], hint: string | undefined, content: string) {
  const folded = fold(`${hint ?? ''} ${content}`);
  return layers.filter((layer) => namedIn(layer, folded));
}

/**
 * Acha a camada `generated` a integrar (D-21), nesta ordem: 1. a selecionada; 2. o nome citado (uma
 * palavra de 4 letras ou mais do nome da camada, no `object` ou na mensagem) que aponta para uma só
 * camada, mesmo com menos de 50% dentro da área (a área de edição continua a marcada; sem marcação, é a
 * caixa da camada); 3. o nome que aponta para duas ou mais: pede a escolha; 4. com área e sem nome, a
 * regra de 50% do PV-35, e mais de uma pede a escolha; 5. nada disso: com marcação, edição local comum;
 * sem marcação, `needs_region` (R29, nunca o ajuste geral). Logo e texto nunca entram.
 */
export async function resolveIntegration(
  classification: SceneClassification,
  input: { content: string; layers: SceneElement[]; scene: IntegrateScene },
): Promise<SceneClassification> {
  const layers = input.layers.filter((layer) => layer.kind === 'generated');
  if (classification.operation === 'needs_region' && classification.reason === 'integrate') {
    const named = namedLayers(layers, classification.subject, input.content);
    if (named.length > 1) return CHOOSE_LAYER;
    return named.length === 1
      ? onLayerBox(input.content, named[0])
      : { operation: 'needs_region', reason: 'item' };
  }
  if (classification.operation !== 'local_edit' || !classification.integrate) return classification;
  return resolveMarked(classification, layers, input);
}

async function resolveMarked(
  plan: LocalEditPlan,
  layers: SceneElement[],
  input: { content: string; scene: IntegrateScene },
): Promise<SceneClassification> {
  if (plan.target.kind === 'element') {
    const { elementId } = plan.target;
    const layer = layers.find((candidate) => candidate.id === elementId);
    return layer ? { ...plan, integrateLayer: layerRef(layer) } : plan;
  }
  const named = namedLayers(layers, plan.object ?? undefined, input.content);
  if (named.length > 1) return CHOOSE_LAYER;
  if (named.length === 1) return { ...plan, integrateLayer: layerRef(named[0]) };
  return resolveInArea(plan, layers, { spec: specOf(plan), scene: input.scene });
}
