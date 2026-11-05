import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskBounds } from '../domain/scene-mask-shape';
import { LocalTarget } from '../domain/scene-operation.classifier';
import { Rect, SceneElement, SceneZoneName } from '../domain/scene.types';
import { SCENE_IMAGE_PROVIDER, SceneImageProvider } from '../providers/scene-image-provider';
import { addElementReply } from '../scene-texts';
import { trimToAlpha } from '../services/scene-element-image';
import { SceneCallRunner } from './scene-call-runner';
import { buildTransparentPrompt } from './scene-prompt';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** PV-3 e D-14: o elemento nasce com 25% da largura (menos, se não couber na altura da zona), no centro da zona citada ou do miolo. */
export const DEFAULT_ELEMENT_WIDTH = 0.25;
const ELEMENT_SIZE = '1024x1024';
const MAX_ELEMENT_WIDTH = 0.9;

/** Caixa onde o elemento nasce: a área marcada, ou `null` (zona citada ou centro do miolo). */
function markedBox(target: LocalTarget | null, ctx: TurnContext): Rect | null {
  if (!target) return null;
  if (target.kind === 'rect') return target.rect;
  if (target.kind === 'mask') return maskBounds(target.mask, ctx.heightPx / ctx.widthPx);
  return null;
}

/** Zona citada (campo `zone` ou texto) quando não há área marcada (D-14). */
function citedZone(target: LocalTarget | null): SceneZoneName | null {
  return target?.kind === 'zone' ? target.zone : null;
}

/**
 * Elemento na caixa marcada (cabendo nela, sem esticar); sem caixa, no centro da zona citada ou do
 * miolo, com a largura padrão reduzida se preciso para caber na altura da zona.
 */
export function placeElement(
  box: Rect | null,
  aspect: number,
  ctx: Pick<TurnContext, 'zones' | 'widthPx' | 'heightPx'>,
  zone: SceneZoneName = 'body',
): { x: number; y: number; w: number } {
  if (!box) {
    const area = ctx.zones[zone];
    const fitWidth = ((area.h * ctx.heightPx) / ctx.widthPx) * aspect;
    return {
      x: 0.5,
      y: area.y + area.h / 2,
      w: Math.min(DEFAULT_ELEMENT_WIDTH, fitWidth),
    };
  }
  const fitWidth = ((box.h * ctx.heightPx) / ctx.widthPx) * aspect;
  const w = Math.min(box.w, fitWidth, MAX_ELEMENT_WIDTH);
  return { x: box.x + box.w / 2, y: box.y + box.h / 2, w };
}

/** Primeira letra maiúscula, para o nome da camada. */
const layerName = (subject: string): string =>
  (subject.charAt(0).toUpperCase() + subject.slice(1)).slice(0, 60);

/**
 * `add_element` (D-11): gera o item como PNG transparente (uma chamada de imagem, sem visão), recorta
 * o alfa e cria um elemento `generated` movível, na caixa marcada, no centro da zona citada ou no centro do miolo. O fundo não
 * muda: a versão aponta para a master da versão de origem.
 */
@Injectable()
export class SceneAddElementHandler implements TurnHandler {
  private readonly logger = new Logger(SceneAddElementHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  async run(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    const plan = ctx.plan;
    if (plan?.operation !== 'add_element' || !ctx.parent) {
      this.logger.error(`Adicionar sem versão de origem ou sem plano (versão ${ctx.versionId})`);
      return state.fail(ctx, 'PROVIDER_ERROR');
    }
    if (!(await state.advance(ctx, 'generating'))) return;
    const result = await this.calls.imageCall(ctx, {
      kind: 'transparent',
      model: this.support.model(),
      size: ELEMENT_SIZE,
      run: () =>
        this.provider.generateTransparent({
          model: this.support.model(),
          prompt: buildTransparentPrompt(plan.subject),
          size: ELEMENT_SIZE,
          quality: this.support.generateQuality(),
          correlationId: ctx.correlationId,
        }),
    });
    if (!result) return;
    const trimmed = await trimToAlpha(result.buffer);
    if (!trimmed) {
      this.logger.warn(`Imagem transparente vazia (versão ${ctx.versionId})`);
      return state.fail(ctx, 'PROVIDER_ERROR');
    }
    if (await state.isCancelRequested(ctx)) return state.cancel(ctx);
    if (!(await state.advance(ctx, 'saving'))) return;
    const box = markedBox(plan.target, ctx);
    const zone = box ? null : citedZone(plan.target);
    const file = await this.support.storeElement(ctx, trimmed.png, trimmed);
    const element = this.buildElement(ctx, plan.subject, file.id, trimmed, box, zone);
    const outcome = await state.completeReusingImage(
      ctx,
      {
        elements: [...(ctx.parent.elements ?? []), element],
        reply: addElementReply(plan.subject, box ? 'area' : (zone ?? 'center')),
        metrics: { addedElementId: element.id },
      },
      file,
    );
    if (outcome !== 'ready') await this.support.removeFiles([file]);
  }

  private buildElement(
    ctx: TurnContext,
    subject: string,
    assetId: string,
    image: { width: number; height: number },
    box: Rect | null,
    zone: SceneZoneName | null,
  ): SceneElement {
    const aspect = image.width / image.height;
    const placed = placeElement(box, aspect, ctx, zone ?? 'body');
    const elements = ctx.parent?.elements ?? [];
    return {
      id: randomUUID(),
      kind: 'generated',
      name: layerName(subject),
      x: placed.x,
      y: placed.y,
      w: placed.w,
      aspect,
      rotation: 0,
      z: Math.max(0, ...elements.map((e) => e.z)) + 1,
      assetId,
    };
  }
}
