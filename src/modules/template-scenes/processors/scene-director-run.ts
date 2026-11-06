import {
  checkComposition,
  COMPOSITION_LABELS,
  CompositionGroup,
} from '../domain/scene-director-composition';
import { applyNumberRule, NumberPatch } from '../domain/scene-director-number';
import {
  answersWithoutImage,
  callsImage,
  hasInstruction,
  unusableAnswer,
  wantsImage,
} from '../domain/scene-director-decision';
import { checkPainted } from '../domain/scene-director-painted';
import { DirectorPlan } from '../domain/scene-director-schema';
import { parseDirector } from '../domain/scene-director';
import { DirectorContext } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { DirectorCallRecord } from './scene-director-cost';

/** Quantas vezes o Diretor é chamado por mensagem: a primeira e, se o plano não serviu, mais uma. */
export const DIRECTOR_MAX_ATTEMPTS = 2;

export type DirectorOutcome =
  /** `patches`: o código cortou só o trecho com ano, data ou número (D-42), depois de refazer uma vez. */
  | { kind: 'plan'; plan: DirectorPlan; patches?: NumberPatch[] }
  /** O plano só tinha o ano como pedido e o corte esvaziou o campo: pergunta ao cliente, sem imagem. */
  | { kind: 'number_question' }
  /** O plano chamaria a imagem sem instrução, duas vezes: pergunta o que mudar, sem imagem (G2). */
  | { kind: 'instruction_question' }
  /** A dúvida de escrita persistiu: pergunta se o cliente quer isso escrito, sem imagem (D-46). */
  | { kind: 'painted_question' }
  /** O plano pediu composição que o cliente não pediu, duas vezes: vira pergunta, sem imagem. */
  | { kind: 'composition_question'; labels: string[] }
  /** Falha, tempo esgotado, quota ou saída inválida duas vezes. */
  | { kind: 'unavailable'; reason: 'invalid' | 'timeout' | 'error' | 'quota' | 'unpriced' };

export interface DirectorRunResult {
  outcome: DirectorOutcome;
  calls: DirectorCallRecord[];
}

const retryNote = (reason: string): string =>
  `\n\nA resposta anterior foi recusada pelo sistema: ${reason}. Responda de novo, só no schema, corrigindo isso.`;

interface Problem {
  reason: string;
  groups?: CompositionGroup[];
  number?: boolean;
  instruction?: boolean;
  painted?: boolean;
}

const QUESTION_OUTCOMES = {
  number: 'number_question',
  instruction: 'instruction_question',
  painted: 'painted_question',
} as const;

const INSTRUCTION_RETRY_REASON =
  'o plano chama a imagem sem dizer o que mudar: preencha what_to_change ou what_to_put com o pedido do cliente';

const ANSWER_RETRY_REASON =
  'o plano diz que não muda a imagem, mas a resposta está vazia ou anuncia uma ação ("vou"): responda ao cliente sem prometer nada, ou chame a imagem de verdade preenchendo what_to_change e what_to_put';

type Checked =
  | { plan: DirectorPlan; patches?: NumberPatch[] }
  | Problem
  | { question: 'number' | 'instruction' | 'painted' };

/** Valida o texto do Diretor: schema, texto e pedidos (1 a 3), recusa de pintado (4), composição (5) e número (7). */
function validate(text: string, context: DirectorContext, final: boolean): Checked {
  const parsed = parseDirector(text, {
    message: context.script.message,
    clientMessages: context.clientMessages,
    briefItems: context.briefItems,
  });
  if (parsed.ok === false) return { reason: parsed.reason };
  const painted = checkPainted(parsed.plan, { final });
  if (painted.kind === 'retry') return { reason: painted.reason, painted: true };
  if (painted.kind === 'question') return { question: 'painted' };
  const plan = painted.plan;
  if (plan.turn_kind === 'recusa_pintado') return { plan };
  // Composição e número protegem o prompt de imagem: plano que não chama imagem não passa por eles (R32).
  const calls = callsImage(plan);
  const composition = calls
    ? checkComposition(plan, context.clientMessages)
    : ({ ok: true } as const);
  if (composition.ok === false) return { reason: composition.reason, groups: composition.groups };
  const written = calls
    ? applyNumberRule(plan, { final })
    : ({ kind: 'ok', plan, patches: [] as NumberPatch[] } as const);
  if (written.kind === 'retry') return { reason: written.reason, number: true };
  if (written.kind === 'question') return { question: 'number' };
  const emptyAnswer = answersWithoutImage(written.plan) && unusableAnswer(written.plan.reply);
  if ((wantsImage(written.plan) && !hasInstruction(written.plan)) || emptyAnswer) {
    return final
      ? { question: 'instruction' }
      : { reason: emptyAnswer ? ANSWER_RETRY_REASON : INSTRUCTION_RETRY_REASON, instruction: true };
  }
  return written.patches.length
    ? { plan: written.plan, patches: written.patches }
    : { plan: written.plan };
}

/**
 * Chama o Diretor até duas vezes: falha de chamada (tempo esgotado, erro, quota, modelo sem preço) não se
 * repete; saída que não passa nas validações refaz uma vez com o motivo. Nunca lança. O custo de cada
 * chamada vai em `calls`, e o chamador o grava fora de `metrics.calls`.
 */
export async function runDirector(
  director: SceneDirectorService,
  input: { context: DirectorContext; correlationId: string },
): Promise<DirectorRunResult> {
  const { context, correlationId } = input;
  const calls: DirectorCallRecord[] = [];
  let last: Problem = { reason: 'saída inválida' };
  for (let attempt = 1; attempt <= DIRECTOR_MAX_ATTEMPTS; attempt += 1) {
    const text = attempt === 1 ? context.text : context.text + retryNote(last.reason);
    const run = await director.run({
      text,
      image: context.image,
      script: context.script,
      correlationId,
    });
    if (run.ok === false) {
      calls.push({
        attempt,
        status: 'failed',
        costUsd: null,
        requestId: null,
        latencyMs: null,
        problem: run.reason,
      });
      return { outcome: { kind: 'unavailable', reason: run.reason }, calls };
    }
    const checked = validate(run.text, context, attempt === DIRECTOR_MAX_ATTEMPTS);
    const record = {
      attempt,
      costUsd: run.costUsd,
      requestId: run.requestId,
      latencyMs: run.latencyMs,
    };
    if ('question' in checked) {
      calls.push({ ...record, status: 'done' });
      return {
        outcome: { kind: QUESTION_OUTCOMES[checked.question] },
        calls,
      };
    }
    if ('plan' in checked) {
      calls.push({ ...record, status: 'done' });
      return {
        outcome: {
          kind: 'plan',
          plan: checked.plan,
          ...(checked.patches ? { patches: checked.patches } : {}),
        },
        calls,
      };
    }
    last = checked;
    calls.push({
      ...record,
      status: 'failed',
      problem: checked.groups
        ? 'composition'
        : checked.number
          ? 'number'
          : checked.instruction
            ? 'instruction'
            : checked.painted
              ? 'painted'
              : 'invalid',
      reason: checked.reason.slice(0, 300),
    });
  }
  const labels = last.groups?.map((group) => COMPOSITION_LABELS[group]);
  return {
    outcome: labels
      ? { kind: 'composition_question', labels }
      : { kind: 'unavailable', reason: 'invalid' },
    calls,
  };
}
