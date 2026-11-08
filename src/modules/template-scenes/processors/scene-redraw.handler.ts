import { Inject, Injectable, Logger } from '@nestjs/common';
import * as sharp from 'sharp';
import { DirectorImage, DirectorPlan } from '../domain/scene-director-schema';
import { imageChange } from '../domain/scene-director-image';
import { hasTextError, TextLine, wrongLines } from '../domain/scene-text-check';
import {
  SCENE_IMAGE_PROVIDER,
  SceneGenerateResult,
  SceneImageProvider,
} from '../providers/scene-image-provider';
import { afterImageReply } from '../scene-texts';
import { SceneVisionService } from '../services/scene-vision.service';
import { ImageCallSpec, SceneCallRunner } from './scene-call-runner';
import { planLayers } from './scene-plan-layers';
import { effectiveSatisfied, JudgedResult, judgeResult, textFactsOf } from './scene-redraw-judge';
import { markupFor, MarkupInfo } from './scene-redraw-markup';
import { buildEditPrompt, buildGeneratePrompt, planRequest, TextCorrection } from './scene-prompt';
import { textCropBox } from './scene-text-crop';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** Uma chamada de imagem montada: o prompt e como chamar o provedor. A refação monta outra com a correção. */
interface Attempt {
  prompt: string;
  spec: ImageCallSpec;
}

interface Concluding {
  plan: DirectorPlan;
  first: { result: SceneGenerateResult; attempt: Attempt };
  /** Monta a segunda chamada da refação do texto, com as linhas lidas diferente do pedido. */
  redo: (corrections: TextCorrection[]) => Attempt;
  before: Buffer | null;
  marking: MarkupInfo | null;
}

/** A imagem que vale: a primeira, ou a segunda depois da refação do texto. */
interface Applied {
  png: Buffer;
  prompt: string;
  judged: JudgedResult;
  tried: 1 | 2;
  limited: boolean;
}

/**
 * O job de imagem (`generate` e `redraw`): a chamada paga que o código monta a partir do plano do Diretor.
 * - `generate`: primeira imagem da cena e imagem nova, sem imagem de referência (`/images/generations`);
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
    const size = `${ctx.widthPx}x${ctx.heightPx}`;
    // A primeira imagem da cena não leva a linha de pedidos em aberto (D-38): o prompt julgado excelente não muda.
    const openItems = ctx.parent ? ctx.openItems.map((item) => item.text) : undefined;
    const build = (corrections: TextCorrection[] = []): Attempt => {
      const prompt = buildGeneratePrompt({
        request: planRequest(plan),
        artWidthCm: ctx.artWidthCm,
        artHeightCm: ctx.artHeightCm,
        widthPx: ctx.widthPx,
        heightPx: ctx.heightPx,
        openItems,
        formatId: ctx.formatId,
        clientMessages: ctx.clientMessages,
        exactText: plan.image?.exact_text,
        corrections,
      });
      const model = this.support.model();
      const run = () =>
        this.provider.generate({
          model,
          prompt,
          size,
          quality: this.support.generateQuality(),
          correlationId: ctx.correlationId,
        });
      return { prompt, spec: { kind: 'generate', model, size, run } };
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
    const { width, height } = await sharp(master).metadata();
    const size = `${width}x${height}`;
    const marking = await markupFor(ctx, { width: width as number, height: height as number });
    const roundText = plan.image?.exact_text ?? [];
    const build = (corrections: TextCorrection[] = []): Attempt => {
      const prompt = buildEditPrompt({
        image: plan.image as DirectorImage,
        composition: plan.turn_kind === 'pedido_composicao',
        marked: Boolean(marking),
        formatId: ctx.formatId,
        clientMessages: ctx.clientMessages,
        widthPx: width as number,
        heightPx: height as number,
        corrections,
        paintedText: roundText.length ? [] : (ctx.parent?.paintedText ?? []),
      });
      const model = this.support.model();
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
    };
    const attempt = build();
    const result = await this.calls.imageCall(ctx, attempt.spec);
    if (result) {
      await this.conclude(ctx, {
        plan,
        first: { result, attempt },
        redo: build,
        before: master,
        marking,
      });
    }
  }

  /** O PNG no tamanho nativo do formato (D-32), de qualquer resposta do provedor. */
  private normalize(ctx: TurnContext, result: SceneGenerateResult): Promise<Buffer> {
    return sharp(result.buffer).resize(ctx.widthPx, ctx.heightPx, { fit: 'fill' }).png().toBuffer();
  }

  /**
   * Texto a conferir: as linhas pedidas nesta rodada; sem elas, as já pintadas e conferidas na versão atual (D-56). Na
   * imagem nova o texto antigo não vale.
   */
  private textPlan(ctx: TurnContext, done: Concluding) {
    const round = done.plan.image?.exact_text ?? [];
    const painted =
      ctx.operation === 'redraw' && !round.length ? (ctx.parent?.paintedText ?? []) : [];
    const expected = [...round, ...painted];
    const known = ctx.operation === 'redraw' ? (ctx.parent?.paintedText ?? []) : [];
    return {
      expected,
      known: known.filter((line) => !expected.includes(line)),
      inherited: expected.map((_line, index) => index >= round.length),
      crop: textCropBox({
        region: done.plan.image?.region ?? null,
        marking: done.marking?.box ?? null,
        formatId: ctx.formatId,
        width: ctx.widthPx,
        height: ctx.heightPx,
      }),
    };
  }

  /**
   * Depois da imagem: grava no tamanho nativo, o juiz confere antes e depois inteiros e lê o texto pintado, e o
   * resultado vira a versão atual em todos os casos (D-26). Texto lido diferente do pedido refaz uma vez, da mesma
   * base (D-51), e a segunda imagem vale, certa ou não; o texto ao cliente sai do que o código conferiu.
   */
  private async conclude(ctx: TurnContext, done: Concluding): Promise<void> {
    const { state } = this.support;
    const deps = { calls: this.calls, vision: this.vision, support: this.support };
    const text = this.textPlan(ctx, done);
    const png = await this.normalize(ctx, done.first.result);
    if (!(await state.advance(ctx, 'checking'))) return;
    const judge = (after: Buffer) =>
      judgeResult(deps, ctx, { plan: done.plan, before: done.before, after, text });
    const first = await judge(png);
    if (first === 'over') return;
    let applied: Applied = {
      png,
      prompt: done.first.attempt.prompt,
      judged: first,
      tried: 1,
      limited: false,
    };
    const attempts = [attemptRecord(1, done.first, first.textLines)];
    const wrong = wrongLines(first.textLines);
    if (first.facts && wrong.length) {
      if (!(await state.advance(ctx, 'retrying_text'))) return;
      const next = done.redo(wrong);
      const result = await this.calls.retryImageCall(ctx, next.spec);
      if (result === null) return;
      if (result === 'limit') {
        applied = { ...applied, limited: true };
      } else {
        const second = await this.recheck(ctx, { result, judge });
        if (second === 'over') return;
        attempts.push(attemptRecord(2, { result, attempt: next }, second.judged.textLines));
        applied = { ...second, prompt: next.prompt, tried: 2, limited: false };
      }
    }
    await this.finish(ctx, { done, applied, attempts, expected: text.expected });
  }

  /** O PNG da segunda imagem e a leitura do juiz sobre ela; `'over'` se o turno acabou. */
  private async recheck(
    ctx: TurnContext,
    input: {
      result: SceneGenerateResult;
      judge: (after: Buffer) => Promise<'over' | JudgedResult>;
    },
  ): Promise<'over' | { png: Buffer; judged: JudgedResult }> {
    const png = await this.normalize(ctx, input.result);
    if (!(await this.support.state.advance(ctx, 'checking'))) return 'over';
    const judged = await input.judge(png);
    return judged === 'over' ? 'over' : { png, judged };
  }

  private async finish(
    ctx: TurnContext,
    input: {
      done: Concluding;
      applied: Applied;
      attempts: unknown[];
      expected: string[];
    },
  ): Promise<void> {
    const { done, applied, attempts, expected } = input;
    const { judged } = applied;
    const lines = judged.textLines;
    const facts = judged.facts
      ? {
          ...judged.facts,
          satisfied: effectiveSatisfied(judged.facts.satisfied, lines),
          text: textFactsOf(lines, applied.tried, applied.limited),
          pendingItem: pendingItemOf(ctx, judged),
        }
      : null;
    // Plano com imagem e camada (defeito b, D-55): as camadas entram na mesma versão, e a resposta junta as duas.
    const layers = await planLayers(ctx, done.plan, applied.png);
    const reply = afterImageReply(facts, { textAsked: expected.length > 0 });
    await this.support.finishWithImage(ctx, applied.png, {
      reply: layers ? `${reply} ${layers.note}` : reply,
      ...(layers ? { elements: layers.elements } : {}),
      judge: judged.verdict,
      metrics: {
        prompt: applied.prompt,
        ...(done.marking ? { markup: { kind: done.marking.kind, box: done.marking.box } } : {}),
        judge: facts ? { ...judged.record, satisfied: facts.satisfied } : judged.record,
        ...(expected.length
          ? {
              textCheck: { expected, attempts, applied: applied.tried, limited: applied.limited },
              paintedText: lines.filter((line) => line.ok && !line.gone).map((line) => line.asked),
            }
          : {}),
      },
    });
  }
}

/**
 * Uma mudança por rodada (D-54): o item aberto desta mensagem que o juiz não viu na imagem, para o chat perguntar se
 * faz agora. O pedido de outras mensagens continua só na lista.
 */
function pendingItemOf(ctx: TurnContext, judged: JudgedResult): string | undefined {
  const seen = judged.verdict?.seen ?? [];
  return ctx.openItems.find(
    (item) =>
      item.sourceMessageId && item.sourceMessageId === ctx.messageId && !seen.includes(item.id),
  )?.text;
}

/** O que a primeira ou a segunda tentativa deixam em `metrics.textCheck.attempts`: prompt, custo e leitura. */
function attemptRecord(
  attempt: number,
  done: { result: SceneGenerateResult; attempt: Attempt },
  lines: TextLine[],
) {
  return {
    attempt,
    prompt: done.attempt.prompt,
    costUsd: done.result.costUsd,
    lines,
    hasError: hasTextError(lines),
  };
}
