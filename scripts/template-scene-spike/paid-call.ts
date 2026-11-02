import { Budget, StopError } from './budget';
import type { Arm } from './budget';
import { classifyCallError } from './errors';
import type { Ledger, LedgerEntry } from './ledger';
import type { CallKind } from './types';

export interface CallContext {
  budget: Budget;
  ledger: Ledger;
  runId: string;
  dryRun: boolean;
}

export interface CallSpec {
  kind: CallKind;
  caseId: string;
  block: string;
  step: string;
  provider: 'openai' | 'replicate';
  endpoint: string;
  model: string;
  size?: string;
  quality?: string;
  /** Braço do bloco A: alimenta os contadores de recusa (P3). */
  arm?: Arm;
}

export interface CallOutcome<T> {
  value: T;
  usage?: unknown;
  requestId?: string | null;
  /** null = sem `usage`: o ledger grava a reserva com `costEstimated: true`. */
  costUsd: number | null;
  /** Custo fixo estimado (ex.: Replicate). */
  costEstimated?: boolean;
}

export interface CallResult<T> {
  value: T;
  costUsd: number;
  latencyMs: number;
  requestId: string | null;
}

function baseEntry(
  ctx: CallContext,
  spec: CallSpec,
): Omit<LedgerEntry, 'costUsd' | 'costEstimated' | 'latencyMs' | 'status'> {
  const { kind, caseId, block, step, provider, endpoint, model, size, quality } = spec;
  return {
    ts: new Date().toISOString(),
    runId: ctx.runId,
    kind,
    caseId,
    block,
    step,
    provider,
    endpoint,
    model,
    size,
    quality,
  };
}

/**
 * Toda chamada paga passa aqui: disjuntor antes, ledger depois (sucesso ou erro) e as paradas P2 a P5.
 * Erro terminal propaga como `StopError`; os demais erros propagam como vieram, após o registro.
 */
export async function runPaidCall<T>(
  ctx: CallContext,
  spec: CallSpec,
  run: () => Promise<CallOutcome<T>>,
): Promise<CallResult<T>> {
  ctx.budget.guard(spec.kind);
  const started = Date.now();
  try {
    const outcome = await run();
    const latencyMs = Date.now() - started;
    const estimated = outcome.costUsd == null || outcome.costEstimated === true;
    const costUsd = outcome.costUsd ?? ctx.budget.reserveFor(spec.kind);
    ctx.ledger.append({
      ...baseEntry(ctx, spec),
      requestId: outcome.requestId ?? null,
      usage: outcome.usage,
      costUsd,
      costEstimated: estimated,
      latencyMs,
      status: ctx.dryRun ? 'dry_run' : 'ok',
    });
    ctx.budget.noteSuccess(spec.arm);
    ctx.budget.checkCallCost(costUsd);
    return { value: outcome.value, costUsd, latencyMs, requestId: outcome.requestId ?? null };
  } catch (err) {
    if (err instanceof StopError) throw err;
    const info = classifyCallError(err);
    ctx.ledger.append({
      ...baseEntry(ctx, spec),
      costUsd: 0,
      costEstimated: false,
      latencyMs: Date.now() - started,
      status: ctx.dryRun ? 'dry_run' : 'error',
      errorCode: info.code,
    });
    if (info.stop) throw new StopError(info.stop, `${info.stop}: ${info.message}`);
    ctx.budget.noteFailure(spec.arm && info.refusedArm === spec.arm ? spec.arm : undefined);
    throw err;
  }
}
