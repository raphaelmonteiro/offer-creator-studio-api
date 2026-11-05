import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskBounds } from '../domain/scene-mask-shape';
import { LocalTarget } from '../domain/scene-operation.classifier';
import { Rect, SceneElement } from '../domain/scene.types';
import { SCENE_IMAGE_PROVIDER, SceneImageProvider } from '../providers/scene-image-provider';
import { addElementReply } from '../scene-texts';
import { trimToAlpha } from '../services/scene-element-image';
import { SceneCallRunner } from './scene-call-runner';
import { buildTransparentPrompt } from './scene-prompt';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** PV-3: sem área marcada (ou com uma zona), o elemento nasce com 25% da largura no centro do miolo. */
export const DEFAULT_ELEMENT_WIDTH = 0.25;
const ELEMENT_SIZE = '1024x1024';
const MAX_ELEMENT_WIDTH = 0.9;

/** Caixa onde o elemento nasce: a área marcada, ou `null` para o centro do miolo. */
function markedBox(target: LocalTarget | null, ctx: TurnContext): Rect | null {
  if (!target) return null;
  if (target.kind === 'rect') return target.rect;
  if (target.kind === 'mask') return maskBounds(target.mask, ctx.heightPx / ctx.widthPx);
  return null;
}

/** Elemento na caixa marcada (cabendo nela, sem esticar) ou com a largura padrão no centro do miolo. */
export function placeElement(
  box: Rect | null,
  aspect: number,
  ctx: Pick<TurnContext, 'zones' | 'widthPx' | 'heightPx'>,
): { x: number; y: number; w: number } {
  if (!box) {
    const body = ctx.zones.body;
    return { x: 0.5, y: body.y + body.h / 2, w: DEFAULT_ELEMENT_WIDTH };
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
 * o alfa e cria um elemento `generated` movível, na caixa marcada ou no centro do miolo. O fundo não
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
    const file = await this.support.storeElement(ctx, trimmed.png, trimmed);
    const element = this.buildElement(ctx, plan.subject, file.id, trimmed, box);
    const outcome = await state.completeReusingImage(
      ctx,
      {
        elements: [...(ctx.parent.elements ?? []), element],
        reply: addElementReply(plan.subject, box ? 'area' : 'center'),
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
  ): SceneElement {
    const aspect = image.width / image.height;
    const placed = placeElement(box, aspect, ctx);
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
