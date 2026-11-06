import { Inject, Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { DirectorPlan } from '../domain/scene-director-schema';
import {
  SCENE_IMAGE_PROVIDER,
  SceneGenerateResult,
  SceneImageProvider,
} from '../providers/scene-image-provider';
import { SceneCallRunner } from './scene-call-runner';
import { markupFor, MarkupInfo } from './scene-redraw-markup';
import { buildGeneratePrompt, buildRedrawPrompt, planRequest, RedrawKind } from './scene-prompt';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** Ajuste geral e composição redesenham a imagem pelo prompt global; o resto é item por texto. */
const GLOBAL_TURNS: ReadonlySet<DirectorPlan['turn_kind']> = new Set([
  'pedido_ajuste_geral',
  'pedido_composicao',
]);

/**
 * O job de imagem (`generate` e `redraw`): a chamada paga que o código monta a partir do plano do Diretor.
 * - `generate`: primeira imagem da cena e imagem nova, sem imagem de referência (`/images/generations`);
 * - `redraw`: sempre a master da versão atual inteira, no tamanho nativo (D-31, D-32), a `gpt-image-2.6-sunburst`
 *   (`/images/edits`), com `markup` quando o cliente marcou e sem ele quando não marcou. Sem recorte, máscara nem
 *   recomposição (D-22). Logo e texto são camadas e nunca vão ao modelo (G1).
 */
@Injectable()
export class SceneRedrawHandler implements TurnHandler {
  private readonly logger = new Logger(SceneRedrawHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  async run(ctx: TurnContext): Promise<void> {
    if (!ctx.plan) {
      this.logger.error(`Versão ${ctx.versionId} sem plano do Diretor: nenhuma imagem é pedida`);
      await this.support.state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    if (ctx.operation === 'generate') return this.generate(ctx, ctx.plan);
    return this.redraw(ctx, ctx.plan);
  }

  private async generate(ctx: TurnContext, plan: DirectorPlan): Promise<void> {
    const { state } = this.support;
    if (!(await state.advance(ctx, 'generating'))) return;
    const size = `${ctx.widthPx}x${ctx.heightPx}`;
    // A primeira imagem da cena não leva a linha de pedidos em aberto (D-38): o prompt julgado excelente não muda.
    const openItems = ctx.parent ? ctx.openItems.map((item) => item.text) : undefined;
    const prompt = buildGeneratePrompt({
      request: planRequest(plan),
      artWidthCm: ctx.artWidthCm,
      artHeightCm: ctx.artHeightCm,
      widthPx: ctx.widthPx,
      heightPx: ctx.heightPx,
      openItems,
    });
    const result = await this.calls.imageCall(ctx, {
      kind: 'generate',
      model: this.support.model(),
      size,
      run: () =>
        this.provider.generate({
          model: this.support.model(),
          prompt,
          size,
          quality: this.support.generateQuality(),
          correlationId: ctx.correlationId,
        }),
    });
    if (result) await this.conclude(ctx, { result, prompt });
  }

  private async redraw(ctx: TurnContext, plan: DirectorPlan): Promise<void> {
    const { state } = this.support;
    const master = await this.support.readMaster(ctx);
    if (!master) {
      this.logger.error(`Master ausente para o redesenho (versão ${ctx.versionId})`);
      await state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    if (!(await state.advance(ctx, 'editing'))) return;
    const { width, height } = await sharp(master).metadata();
    const size = `${width}x${height}`;
    const marking = await markupFor(ctx, { width: width as number, height: height as number });
    const kind: RedrawKind = marking
      ? 'marked'
      : GLOBAL_TURNS.has(plan.turn_kind)
        ? 'global'
        : 'item';
    const prompt = buildRedrawPrompt({
      kind,
      plan,
      openItems: ctx.openItems.map((item) => item.text),
    });
    const result = await this.calls.imageCall(ctx, {
      kind: 'edit',
      model: this.support.model(),
      size,
      run: () =>
        this.provider.edit({
          model: this.support.model(),
          prompt,
          size,
          quality: this.support.editQuality(),
          correlationId: ctx.correlationId,
          image: master,
          ...(marking ? { markup: marking.png } : {}),
        }),
    });
    if (result) await this.conclude(ctx, { result, prompt, marking });
  }

  /** Grava a imagem no tamanho nativo da cena; o resultado vira a versão atual. O juiz entra na task 1.17. */
  private async conclude(
    ctx: TurnContext,
    done: { result: SceneGenerateResult; prompt: string; marking?: MarkupInfo | null },
  ): Promise<void> {
    const png = await sharp(done.result.buffer)
      .resize(ctx.widthPx, ctx.heightPx, { fit: 'fill' })
      .png()
      .toBuffer();
    await this.support.finishWithImage(ctx, png, {
      metrics: {
        prompt: done.prompt,
        ...(done.marking ? { markup: { kind: done.marking.kind, box: done.marking.box } } : {}),
      },
    });
  }
}
