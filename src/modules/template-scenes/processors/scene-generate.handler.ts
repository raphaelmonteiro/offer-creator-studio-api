import { Inject, Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { SCENE_IMAGE_PROVIDER, SceneImageProvider } from '../providers/scene-image-provider';
import { editReply } from '../scene-texts';
import { SceneVisionService } from '../services/scene-vision.service';
import { SceneCallRunner } from './scene-call-runner';
import { buildGeneratePrompt, buildGlobalPrompt } from './scene-prompt';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnHandler } from './scene-turn-handler';
import { TurnContext } from './scene-turn-state';

/**
 * `generate` (primeira geração) e `global_regenerate` (ajuste geral confirmado). O ajuste geral edita a
 * master inteira, no tamanho nativo e sem máscara, com a imagem atual como referência; logo e texto são
 * camadas e ficam como estão (os elementos `generated` também: a composição é mantida).
 */
@Injectable()
export class SceneGenerateHandler implements TurnHandler {
  private readonly logger = new Logger(SceneGenerateHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    private readonly vision: SceneVisionService,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  run(ctx: TurnContext): Promise<void> {
    return ctx.plan?.operation === 'global_regenerate' ? this.regenerate(ctx) : this.generate(ctx);
  }

  private async generate(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    if (!(await state.advance(ctx, 'generating'))) return;
    const size = `${ctx.widthPx}x${ctx.heightPx}`;
    const result = await this.calls.imageCall(ctx, {
      kind: 'generate',
      model: this.support.model(),
      size,
      run: () =>
        this.provider.generate({
          model: this.support.model(),
          prompt: buildGeneratePrompt({ ...ctx, request: ctx.request }),
          size,
          quality: this.support.generateQuality(),
          correlationId: ctx.correlationId,
        }),
    });
    if (result) await this.finish(ctx, result.buffer);
  }

  private async regenerate(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    const master = await this.support.readMaster(ctx);
    if (!master) {
      this.logger.error(`Master ausente para o ajuste geral (versão ${ctx.versionId})`);
      await state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    if (!(await state.advance(ctx, 'generating'))) return;
    const instruction =
      ctx.plan?.operation === 'global_regenerate' ? ctx.plan.instruction : ctx.request;
    const next = await this.editWholeScene(ctx, master, instruction);
    if (!next) return;
    if (!(await state.advance(ctx, 'checking'))) return;
    const assessment = await this.calls.visionCall(ctx, {
      model: this.vision.model(),
      run: async () =>
        this.vision.assess({
          request: instruction,
          before: await this.support.thumbnail(master),
          after: await this.support.thumbnail(next),
          correlationId: ctx.correlationId,
        }),
    });
    if (assessment.status === 'over') return;
    const facts = assessment.status === 'ok' && assessment.value.ok ? assessment.value : null;
    await this.support.finishWithImage(ctx, next, {
      reply: editReply(facts, 'scene'),
      metrics: {
        globalInstruction: instruction,
        vision: facts ? { satisfied: facts.satisfied } : null,
      },
    });
  }

  /** `images.edit` sem máscara sobre a master inteira; devolve a saída no tamanho da cena, ou `null` se a chamada não deu resultado. */
  private async editWholeScene(
    ctx: TurnContext,
    master: Buffer,
    instruction: string,
  ): Promise<Buffer | null> {
    const size = `${ctx.widthPx}x${ctx.heightPx}`;
    const result = await this.calls.imageCall(ctx, {
      kind: 'edit',
      model: this.support.model(),
      size,
      run: () =>
        this.provider.edit({
          model: this.support.model(),
          prompt: buildGlobalPrompt({ request: instruction, zones: ctx.zones }),
          size,
          quality: this.support.editQuality(),
          correlationId: ctx.correlationId,
          image: master,
        }),
    });
    if (!result) return null;
    return sharp(result.buffer).resize(ctx.widthPx, ctx.heightPx, { fit: 'fill' }).png().toBuffer();
  }

  private finish(ctx: TurnContext, png: Buffer): Promise<void> {
    return this.support.finishWithImage(ctx, png);
  }
}
