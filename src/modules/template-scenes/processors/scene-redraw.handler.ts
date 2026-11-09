import { Inject, Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { DirectorImage, DirectorPlan } from '../domain/scene-director-schema';
import { hasTwoFaces } from '../domain/scene-faces';
import { imageChange } from '../domain/scene-director-image';
import { SCENE_IMAGE_PROVIDER, SceneImageProvider } from '../providers/scene-image-provider';
import { SceneVisionService } from '../services/scene-vision.service';
import { SceneCallRunner } from './scene-call-runner';
import { Attempt, concludeImage, Concluding } from './scene-redraw-conclude';
import { markupFor } from './scene-redraw-markup';
import { buildRoundText } from './scene-redraw-text-plan';
import { generatePromptFor } from './scene-generate-prompt';
import { buildEditPrompt, TextCorrection } from './scene-prompt';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

interface EditInput {
  ctx: TurnContext;
  plan: DirectorPlan;
  master: Buffer;
  size: { width: number; height: number };
  marking: Awaited<ReturnType<typeof markupFor>>;
  text: ReturnType<typeof buildRoundText>;
}

/**
 * O job de imagem (`generate` e `redraw`): a chamada paga que o código monta a partir do plano do Diretor.
 * - `generate`: primeira imagem da cena e imagem nova, sem imagem de referência (`/images/generations`); a nascida da
 *   ficha do encarte é a única exceção: `edit` com o encarte reduzido (change add-template-scene-from-reference);
 * - `redraw`: sempre a master da versão atual inteira, no tamanho nativo (D-31, D-32), a `gpt-image-2.6-sunburst`
 *   (`/images/edits`), com `markup` quando o cliente marcou. Sem recorte, máscara nem recomposição (D-22). Logo é
 *   camada e nunca vai ao modelo (G1).
 * - texto pintado (D-51): o juiz lê, o código compara, e erro refaz uma vez da mesma base (`retrying_text`).
 */
@Injectable()
export class SceneRedrawHandler implements TurnHandler {
  private readonly logger = new Logger(SceneRedrawHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    private readonly vision: SceneVisionService,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  async run(ctx: TurnContext): Promise<void> {
    if (!ctx.plan) {
      this.logger.error(`Versão ${ctx.versionId} sem plano do Diretor: nenhuma imagem é pedida`);
      await this.support.state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    // Plano no formato antigo (job `generate` publicado antes da conversa) ou sem instrução: nenhuma chamada paga.
    if (typeof ctx.plan.turn_kind !== 'string' || !ctx.plan.image || !imageChange(ctx.plan)) {
      this.logger.error(
        `Versão ${ctx.versionId} com plano sem formato ou sem instrução: nenhuma imagem é pedida`,
      );
      await this.support.state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    if (ctx.operation === 'generate') return this.generate(ctx, ctx.plan);
    return this.redraw(ctx, ctx.plan);
  }

  private async generate(ctx: TurnContext, plan: DirectorPlan): Promise<void> {
    const { state } = this.support;
    if (!(await state.advance(ctx, 'generating'))) return;
    // Geração nascida da ficha do encarte: a única imagem nova com referência (`edit` com o encarte reduzido).
    const concept = ctx.reference?.concept ?? undefined;
    const referenceImage = concept ? await this.support.readFile(ctx.reference?.assetUrl) : null;
    if (concept && !referenceImage) {
      this.logger.error(`Encarte ausente para gerar (versão ${ctx.versionId})`);
      await state.fail(ctx, 'PROVIDER_ERROR');
      return;
    }
    const size = `${ctx.widthPx}x${ctx.heightPx}`;
    // A primeira imagem da cena não leva a linha de pedidos em aberto (D-38): o prompt julgado excelente não muda.
    const openItems = ctx.parent && !concept ? ctx.openItems.map((item) => item.text) : undefined;
    const build = (corrections: TextCorrection[] = []): Attempt => {
      const prompt = generatePromptFor(ctx, { plan, openItems, corrections, concept });
      const model = this.support.model();
      const quality = this.support.generateQuality();
      const base = { model, prompt, size, quality, correlationId: ctx.correlationId };
      const run = () =>
        referenceImage
          ? this.provider.edit({ ...base, image: referenceImage })
          : this.provider.generate(base);
      return { prompt, spec: { kind: referenceImage ? 'edit' : 'generate', model, size, run } };
    };
    const attempt = build();
    const result = await this.calls.imageCall(ctx, attempt.spec);
    if (!result) return;
    const before = ctx.parent ? await this.support.readMaster(ctx) : null;
    await this.conclude(ctx, {
      plan,
      first: { result, attempt },
      redo: build,
      before,
      marking: null,
      text: buildRoundText(ctx, plan, null),
    });
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
    const meta = await sharp(master).metadata();
    const size = { width: meta.width as number, height: meta.height as number };
    const marking = await markupFor(ctx, size);
    const text = buildRoundText(ctx, plan, marking?.box ?? null);
    const build = (corrections: TextCorrection[] = []): Attempt =>
      this.editAttempt({ ctx, plan, master, size, marking, text }, corrections);
    const attempt = build();
    const result = await this.calls.imageCall(ctx, attempt.spec);
    if (result) {
      await this.conclude(ctx, {
        plan,
        first: { result, attempt },
        redo: build,
        before: master,
        marking,
        text,
      });
    }
  }

  /** A chamada de edição sobre a master inteira, com a marcação e o texto a manter (a base de `build`). */
  private editAttempt(input: EditInput, corrections: TextCorrection[]): Attempt {
    const { ctx, plan, master, marking, text } = input;
    const { width, height } = input.size;
    const prompt = buildEditPrompt({
      image: plan.image as DirectorImage,
      composition: plan.turn_kind === 'pedido_composicao',
      marked: Boolean(marking),
      formatId: ctx.formatId,
      clientMessages: ctx.clientMessages,
      widthPx: width,
      heightPx: height,
      corrections,
      keepText: text.keep,
      zones: ctx.zones,
      faceKey: hasTwoFaces(ctx.layout) ? ctx.faceKey : undefined,
    });
    const model = this.support.model();
    const size = `${width}x${height}`;
    const run = () =>
      this.provider.edit({
        model,
        prompt,
        size,
        quality: this.support.editQuality(),
        correlationId: ctx.correlationId,
        image: master,
        ...(marking ? { markup: marking.png } : {}),
      });
    return { prompt, spec: { kind: 'edit', model, size, run } };
  }

  private conclude(ctx: TurnContext, done: Concluding): Promise<void> {
    const deps = { calls: this.calls, vision: this.vision, support: this.support };
    return concludeImage(deps, ctx, done);
  }
}
