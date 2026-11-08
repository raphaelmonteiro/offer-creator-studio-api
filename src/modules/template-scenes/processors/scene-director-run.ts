import { COMPOSITION_LABELS } from '../domain/scene-director-composition';
import { DirectorPlan } from '../domain/scene-director-schema';
import { DirectorContext } from '../services/scene-director-context';
import {
  Checked,
  PlanPatches,
  Problem,
  QUESTION_OUTCOMES,
  validate,
} from './scene-director-validate';
import { SceneDirectorService } from '../services/scene-director.service';
import { DirectorCallRecord } from './scene-director-cost';

/** Quantas vezes o Diretor é chamado por mensagem: a primeira e, se o plano não serviu, mais uma. */
export const DIRECTOR_MAX_ATTEMPTS = 2;

export type DirectorOutcome =
  /** `patches`: o código cortou só um trecho (número, D-42; texto fora do bloco, D-51), depois de refazer uma vez. */
  | { kind: 'plan'; plan: DirectorPlan; patches?: PlanPatches }
  /** O plano só tinha o ano como pedido e o corte esvaziou o campo: pergunta ao cliente, sem imagem. */
  | { kind: 'number_question' }
  /** O texto a pintar não está nas mensagens do cliente, duas vezes: pergunta o texto exato, sem imagem (4a). */
  | { kind: 'exact_text_question' }
  /** O plano chamaria a imagem sem instrução, duas vezes: pergunta o que mudar, sem imagem (G2). */
  | { kind: 'instruction_question' }
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

/** A chamada que falhou antes de haver resposta: custo desconhecido, sem repetir. */
const failedCall = (attempt: number, problem: string): DirectorCallRecord => ({
  attempt,
  status: 'failed',
  costUsd: null,
  requestId: null,
  latencyMs: null,
  problem,
});

/** Por que a tentativa não serviu, para `metrics.director.calls[].problem`. */
function problemLabel(problem: Problem): string {
  if (problem.text) return 'text';
  if (problem.groups) return 'composition';
  if (problem.number) return 'number';
  if (problem.instruction) return 'instruction';
  if (problem.announcement) return 'announcement';
  return 'invalid';
}

/** O desfecho de uma tentativa que serviu: a pergunta ao cliente ou o plano. */
function acceptedOutcome(checked: Extract<Checked, { question: string } | { plan: DirectorPlan }>) {
  if ('question' in checked) return { kind: QUESTION_OUTCOMES[checked.question] } as const;
  return {
    kind: 'plan',
    plan: checked.plan,
    ...(checked.patches ? { patches: checked.patches } : {}),
  } as const;
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
      calls.push(failedCall(attempt, run.reason));
      return { outcome: { kind: 'unavailable', reason: run.reason }, calls };
    }
    const checked = validate(run.text, context, attempt === DIRECTOR_MAX_ATTEMPTS);
    const record = {
      attempt,
      costUsd: run.costUsd,
      requestId: run.requestId,
      latencyMs: run.latencyMs,
    };
    if ('question' in checked || 'plan' in checked) {
      calls.push({ ...record, status: 'done' });
      return { outcome: acceptedOutcome(checked), calls };
    }
    last = checked;
    calls.push({
      ...record,
      status: 'failed',
      problem: problemLabel(checked),
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
