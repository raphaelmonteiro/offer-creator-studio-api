import {
  checkComposition,
  COMPOSITION_LABELS,
  CompositionGroup,
} from '../domain/scene-director-composition';
import { enforcePaintedRefusal } from '../domain/scene-director-painted';
import { DirectorPlan } from '../domain/scene-director-schema';
import { parseDirector } from '../domain/scene-director';
import { DirectorContext } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { DirectorCallRecord } from './scene-director-cost';

/** Quantas vezes o Diretor é chamado por mensagem: a primeira e, se o plano não serviu, mais uma. */
export const DIRECTOR_MAX_ATTEMPTS = 2;

export type DirectorOutcome =
  | { kind: 'plan'; plan: DirectorPlan }
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
}

/** Valida o texto do Diretor: schema, texto e pedidos (1 a 3), recusa de pintado (4) e composição (5). */
function validate(text: string, context: DirectorContext): { plan: DirectorPlan } | Problem {
  const parsed = parseDirector(text, {
    message: context.script.message,
    clientMessages: context.clientMessages,
    briefIds: context.briefIds,
  });
  if (parsed.ok === false) return { reason: parsed.reason };
  const plan = enforcePaintedRefusal(parsed.plan);
  if (plan.turn_kind === 'recusa_pintado') return { plan };
  const composition = checkComposition(plan, context.clientMessages);
  return composition.ok === true
    ? { plan }
    : { reason: composition.reason, groups: composition.groups };
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
    const checked = validate(run.text, context);
    const record = {
      attempt,
      costUsd: run.costUsd,
      requestId: run.requestId,
      latencyMs: run.latencyMs,
    };
    if ('plan' in checked) {
      calls.push({ ...record, status: 'done' });
      return { outcome: { kind: 'plan', plan: checked.plan }, calls };
    }
    last = checked;
    calls.push({
      ...record,
      status: 'failed',
      problem: checked.groups ? 'composition' : 'invalid',
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
