import { Inject, Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { DirectorPlan } from '../domain/scene-director-schema';
import {
  SCENE_IMAGE_PROVIDER,
  SceneGenerateResult,
  SceneImageProvider,
} from '../providers/scene-image-provider';
import { promptableTexts } from '../domain/scene-director-painted';
import { safeChanged } from '../domain/scene-director-phrases';
import { JudgeBriefVerdict } from '../domain/scene-brief';
import { afterImageReply, JudgeFacts } from '../scene-texts';
import { SceneVisionService } from '../services/scene-vision.service';
import { SceneCallRunner } from './scene-call-runner';
import { markupFor, MarkupInfo } from './scene-redraw-markup';
import { buildGeneratePrompt, buildRedrawPrompt, planRequest, RedrawKind } from './scene-prompt';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** Ajuste geral e composição redesenham a imagem pelo prompt global; o resto é item por texto. */
const GLOBAL_TURNS: ReadonlyMap<DirectorPlan['turn_kind'], RedrawKind> = new Map([
  ['pedido_ajuste_geral', 'global'],
  ['pedido_composicao', 'composition'],
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
    private readonly vision: SceneVisionService,
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
    const openItems = ctx.parent
      ? promptableTexts(ctx.openItems.map((item) => item.text))
      : undefined;
    const prompt = buildGeneratePrompt({
      request: planRequest(plan),
      artWidthCm: ctx.artWidthCm,
      artHeightCm: ctx.artHeightCm,
      widthPx: ctx.widthPx,
      heightPx: ctx.heightPx,
      openItems,
      formatId: ctx.formatId,
      clientMessages: ctx.clientMessages,
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
    if (result) {
      const before = ctx.parent ? await this.support.readMaster(ctx) : null;
      await this.conclude(ctx, { result, prompt, plan, before });
    }
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
    const kind: RedrawKind = marking ? 'marked' : (GLOBAL_TURNS.get(plan.turn_kind) ?? 'item');
    const prompt = buildRedrawPrompt({
      kind,
      plan,
      openItems: promptableTexts(ctx.openItems.map((item) => item.text)),
      formatId: ctx.formatId,
      clientMessages: ctx.clientMessages,
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
    if (result) await this.conclude(ctx, { result, prompt, plan, before: master, marking });
  }

  /**
   * Depois da imagem: grava no tamanho nativo, o juiz confere antes e depois inteiros com a mensagem, o plano e os
   * itens em aberto, e o resultado vira a versão atual em todos os casos (D-26), inclusive com o juiz reprovando,
   * parcial ou indisponível. O texto ao cliente sai do que o juiz conferiu, montado pelo código.
   */
  private async conclude(
    ctx: TurnContext,
    done: {
      result: SceneGenerateResult;
      prompt: string;
      plan: DirectorPlan;
      before: Buffer | null;
      marking?: MarkupInfo | null;
    },
  ): Promise<void> {
    const png = await sharp(done.result.buffer)
      .resize(ctx.widthPx, ctx.heightPx, { fit: 'fill' })
      .png()
      .toBuffer();
    if (!(await this.support.state.advance(ctx, 'checking'))) return;
    const judged = await this.judge(ctx, { ...done, after: png });
    if (judged === 'over') return;
    await this.support.finishWithImage(ctx, png, {
      reply: afterImageReply(judged.facts),
      judge: judged.verdict,
      metrics: {
        prompt: done.prompt,
        ...(done.marking ? { markup: { kind: done.marking.kind, box: done.marking.box } } : {}),
        judge: judged.record,
      },
    });
  }

  /** O juiz: fatos, veredito sobre a lista e o registro de auditoria; `'over'` se o turno já acabou (parada ou cena excluída). */
  private async judge(
    ctx: TurnContext,
    input: { plan: DirectorPlan; before: Buffer | null; after: Buffer },
  ): Promise<
    | 'over'
    | { facts: JudgeFacts | null; verdict?: JudgeBriefVerdict; record: Record<string, unknown> }
  > {
    const call = await this.calls.visionCall(ctx, {
      model: this.vision.model(),
      run: async () =>
        this.vision.assess({
          message: ctx.request,
          plan: input.plan,
          openItems: ctx.openItems,
          doneItems: ctx.doneItems,
          hasBefore: Boolean(input.before),
          before: input.before ? await this.support.judgeImage(input.before) : undefined,
          after: await this.support.judgeImage(input.after),
          correlationId: ctx.correlationId,
        }),
    });
    if (call.status === 'over') return 'over';
    if (call.status === 'skipped' || call.value.ok === false) {
      return { facts: null, record: { available: false } };
    }
    const assessment = call.value;
    const labelOf = new Map(
      [...ctx.openItems, ...ctx.doneItems].map((item) => [item.id, item.text]),
    );
    return {
      facts: {
        satisfied: assessment.satisfied,
        changed: safeChanged(assessment.changed),
        missing: assessment.notSeen.map((id) => labelOf.get(id) as string).filter(Boolean),
        textInImage: assessment.textInImage,
      },
      verdict: { seen: assessment.seen, notSeen: assessment.notSeen },
      record: {
        available: true,
        satisfied: assessment.satisfied,
        changed: assessment.changed,
        seen: assessment.seen,
        notSeen: assessment.notSeen,
        textInImage: assessment.textInImage,
      },
    };
  }
}
