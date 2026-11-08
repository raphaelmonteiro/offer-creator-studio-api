import * as sharp from 'sharp';
import { DirectorPlan } from '../domain/scene-director-schema';
import { nextPaintedLines } from '../domain/scene-painted-text';
import { hasTextError, TextLine, wrongLines } from '../domain/scene-text-check';
import { SceneGenerateResult } from '../providers/scene-image-provider';
import { afterImageReply } from '../scene-texts';
import { FailedRetry, ImageCallSpec } from './scene-call-runner';
import { planLayers } from './scene-plan-layers';
import {
  effectiveSatisfied,
  JudgedResult,
  judgeResult,
  JudgeDeps,
  textFactsOf,
} from './scene-redraw-judge';
import { MarkupInfo } from './scene-redraw-markup';
import { RoundText } from './scene-redraw-text-plan';
import { TextCorrection } from './scene-prompt';
import { TurnContext } from './scene-turn-state';

/** Uma chamada de imagem montada: o prompt e como chamar o provedor. A refação monta outra com a correção. */
export interface Attempt {
  prompt: string;
  spec: ImageCallSpec;
}

export interface Concluding {
  plan: DirectorPlan;
  first: { result: SceneGenerateResult; attempt: Attempt };
  /** Monta a segunda chamada da refação do texto, com as linhas lidas diferente do pedido. */
  redo: (corrections: TextCorrection[]) => Attempt;
  before: Buffer | null;
  marking: MarkupInfo | null;
  text: RoundText;
}

/** A imagem que vale: a primeira, ou a segunda depois da refação do texto. */
interface Applied {
  png: Buffer;
  prompt: string;
  judged: JudgedResult;
  tried: 1 | 2;
  /** Não refez porque o limite de chamadas pagas do pedido não deixou. */
  limited: boolean;
  /** A segunda chamada de imagem falhou no provedor: a primeira, já paga, vale (rodada 6). */
  secondFailed: boolean;
  /** As linhas que a refação quis corrigir (o que a primeira leitura pediu e não achou igual). */
  redone: string[];
}

/** O PNG no tamanho nativo do formato (D-32), de qualquer resposta do provedor. */
export const normalize = (ctx: TurnContext, result: SceneGenerateResult): Promise<Buffer> =>
  sharp(result.buffer).resize(ctx.widthPx, ctx.heightPx, { fit: 'fill' }).png().toBuffer();

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

/** A segunda tentativa que falhou no provedor: o custo e o código ficam no registro. */
const failedRecord = (next: Attempt, failure: FailedRetry['failed']) => ({
  attempt: 2,
  prompt: next.prompt,
  costUsd: failure.costUsd,
  errorCode: failure.code,
  failed: true,
});

type Judge = (after: Buffer) => Promise<'over' | JudgedResult>;

/**
 * A refação única do texto (D-51): segunda imagem da mesma base, com a linha de correção, e o juiz de novo. Sem vaga
 * para a segunda imagem, ou com o provedor falhando, a primeira vale; o chat diz o que aconteceu. `'over'`: o turno
 * acabou (parada ou cena excluída).
 */
async function redoText(
  deps: JudgeDeps,
  ctx: TurnContext,
  input: { done: Concluding; applied: Applied; judge: Judge; attempts: unknown[] },
): Promise<'over' | Applied> {
  const { done, judge, attempts } = input;
  const { state } = deps.support;
  const wrong = wrongLines(input.applied.judged.textLines);
  const applied = { ...input.applied, redone: wrong.map((line) => line.asked) };
  if (!(await state.advance(ctx, 'retrying_text'))) return 'over';
  const next = done.redo(wrong);
  const result = await deps.calls.retryImageCall(ctx, next.spec);
  if (result === null) return 'over';
  if (result === 'limit') return { ...applied, limited: true };
  if ('failed' in result) {
    attempts.push(failedRecord(next, result.failed));
    return { ...applied, secondFailed: true };
  }
  const png = await normalize(ctx, result);
  if (!(await state.advance(ctx, 'checking'))) return 'over';
  const judged = await judge(png);
  if (judged === 'over') return 'over';
  attempts.push(attemptRecord(2, { result, attempt: next }, judged.textLines));
  return { ...applied, png, prompt: next.prompt, judged, tried: 2 };
}

/**
 * Depois da imagem: grava no tamanho nativo, o juiz confere antes e depois inteiros e lê o texto pintado, e o
 * resultado vira a versão atual em todos os casos (D-26). Texto lido diferente do pedido refaz uma vez, da mesma
 * base (D-51), e a segunda imagem vale, certa ou não; o texto ao cliente sai do que o código conferiu.
 */
export async function concludeImage(
  deps: JudgeDeps,
  ctx: TurnContext,
  done: Concluding,
): Promise<void> {
  const png = await normalize(ctx, done.first.result);
  if (!(await deps.support.state.advance(ctx, 'checking'))) return;
  const judge: Judge = (after) =>
    judgeResult(deps, ctx, { plan: done.plan, before: done.before, after, text: done.text });
  const first = await judge(png);
  if (first === 'over') return;
  const attempts: unknown[] = [attemptRecord(1, done.first, first.textLines)];
  let applied: Applied = {
    png,
    prompt: done.first.attempt.prompt,
    judged: first,
    tried: 1,
    limited: false,
    secondFailed: false,
    redone: [],
  };
  if (first.facts && hasTextError(first.textLines)) {
    const redone = await redoText(deps, ctx, { done, applied, judge, attempts });
    if (redone === 'over') return;
    applied = redone;
  }
  await finishConcluded(deps, ctx, { done, applied, attempts });
}

/**
 * Uma mudança por rodada (D-54): o item aberto desta mensagem que o juiz não viu na imagem (`nao_vistos`), para o chat
 * perguntar se faz agora. Item que o juiz não pôs em `nao_vistos` não é oferecido (R68). O pedido de outras mensagens
 * continua só na lista.
 */
function pendingItemOf(ctx: TurnContext, judged: JudgedResult): string | undefined {
  const notSeen = judged.verdict?.notSeen ?? [];
  return ctx.openItems.find(
    (item) =>
      item.sourceMessageId && item.sourceMessageId === ctx.messageId && notSeen.includes(item.id),
  )?.text;
}

/** A segunda imagem foi aplicada sem conferência: o chat diz isso, sem afirmar que o texto está certo. */
function unconferredRedo(applied: Applied) {
  const { judged } = applied;
  return applied.tried === 2 && !judged.facts
    ? { asked: applied.redone, limit: judged.unavailable === 'limit' }
    : undefined;
}

async function finishConcluded(
  deps: JudgeDeps,
  ctx: TurnContext,
  input: { done: Concluding; applied: Applied; attempts: unknown[] },
): Promise<void> {
  const { done, applied, attempts } = input;
  const { judged } = applied;
  const lines = judged.textLines;
  const { expected } = done.text;
  const facts = judged.facts
    ? {
        ...judged.facts,
        satisfied: effectiveSatisfied(judged.facts.satisfied, lines),
        text: textFactsOf(lines, applied),
        pendingItem: pendingItemOf(ctx, judged),
      }
    : null;
  // Plano com imagem e camada (defeito b, D-55): as camadas entram na mesma versão, e a resposta junta as duas.
  const layers = await planLayers(ctx, done.plan, applied.png);
  const reply = afterImageReply(facts, {
    textAsked: expected.length > 0,
    redo: unconferredRedo(applied),
  });
  await deps.support.finishWithImage(ctx, applied.png, {
    reply: layers ? `${reply} ${layers.note}` : reply,
    ...(layers ? { elements: layers.elements } : {}),
    judge: judged.verdict,
    metrics: {
      prompt: applied.prompt,
      ...(done.marking ? { markup: { kind: done.marking.kind, box: done.marking.box } } : {}),
      judge: facts ? { ...judged.record, satisfied: facts.satisfied } : judged.record,
      ...(expected.length
        ? {
            textCheck: {
              expected,
              attempts,
              applied: applied.tried,
              limited: applied.limited,
              ...(applied.secondFailed ? { secondFailed: true } : {}),
            },
            paintedText: nextPaintedLines(done.text.lines, judged.facts ? lines : null),
          }
        : {}),
    },
  });
}
