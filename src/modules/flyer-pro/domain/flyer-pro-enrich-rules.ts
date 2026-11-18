import { pgErrorOf } from '../../../shared/db/pg-error';
import type { FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import type {
  EnrichError,
  EnrichErrorCode,
  EnrichModels,
  EnrichPhase,
  EnrichResult,
  EnrichStep,
  JobStatus,
} from './flyer-pro-job.types';

/**
 * As regras puras do job de enriquecimento (change 28): ordem das fases, transições de estado, conferência final,
 * `stalled`, repetição depois de falha, decisão da varredura e os acumuladores de `result` e `models`. Sem banco e sem
 * relógio: o instante entra como argumento.
 */

/** O nome do índice único parcial da M3: um job ativo por encarte. */
export const ACTIVE_JOB_INDEX = 'UQ_flyer_pro_jobs_document_active';

/** `23505` do índice de job ativo: outro job `queued` ou `running` do mesmo encarte passou na frente. */
export function isActiveJobConflict(error: unknown): boolean {
  const driver = pgErrorOf(error);
  return driver?.code === '23505' && driver.constraint === ACTIVE_JOB_INDEX;
}

/** A ordem fixa das fases, qualquer que seja a ordem de `steps` no pedido. */
export const ENRICH_PHASE_ORDER: readonly EnrichStep[] = [
  'categorize',
  'spellcheck',
  'image_match',
];

/** Rodadas de conferência de itens que chegaram durante o job (a primeira conta). */
export const ENRICH_MAX_ROUNDS = 3;

/** O N15 diz `stalled` depois de tanto tempo sem atividade. */
export const STALLED_AFTER_MS = 180_000;

/** Lote publicado e não assumido há tanto tempo é republicado pela varredura, sem contar tentativa. */
export const LOST_BATCH_AFTER_SECONDS = 300;

export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Espera antes de repetir o lote depois de falha do provedor: a primeira e a segunda repetição. */
export const RETRY_DELAYS_SECONDS: readonly number[] = [15, 60];

/** `steps` na ordem fixa e sem repetição; o que não é fase conhecida fica de fora. */
export function orderedSteps(steps: readonly string[]): EnrichStep[] {
  return ENRICH_PHASE_ORDER.filter((phase) => steps.includes(phase));
}

/** As fases pedidas que ainda valem: a pulada (`skipped`) não volta nas rodadas seguintes. */
export function runnablePhases(steps: readonly EnrichStep[], result: EnrichResult): EnrichStep[] {
  return steps.filter((phase) => result[phase]?.skipped !== 'AI_DISABLED');
}

/** A fase depois de `current` (ou a primeira, sem `current`); `null` depois da última. */
export function nextPhase(
  phases: readonly EnrichStep[],
  current: EnrichPhase | null,
): EnrichStep | null {
  const ordered = ENRICH_PHASE_ORDER.filter((phase) => phases.includes(phase));
  if (current === null) return ordered[0] ?? null;
  const index = ordered.indexOf(current as EnrichStep);
  return ordered[index + 1] ?? null;
}

/** O tamanho do lote de cada fase, da configuração. */
export function batchSizeOf(phase: EnrichStep, config: FlyerProEnrichConfig): number {
  if (phase === 'categorize') return config.categoryBatch;
  if (phase === 'spellcheck') return config.spellBatch;
  return config.imageBatch;
}

/** Da segunda rodada em diante vale sempre o critério de `onlyMissing` ligado (conferência final). */
export const effectiveOnlyMissing = (onlyMissing: boolean, round: number): boolean =>
  round > 1 ? true : onlyMissing;

/** Havendo item novo e rodada sobrando, o job faz outra rodada; senão termina. */
export const needsAnotherRound = (round: number, pending: number): boolean =>
  pending > 0 && round < ENRICH_MAX_ROUNDS;

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'canceled'],
  running: ['done', 'failed', 'canceled'],
  done: [],
  failed: [],
  canceled: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const isActiveStatus = (status: JobStatus): boolean =>
  status === 'queued' || status === 'running';

/** O que um estado final grava: `done` zera a fase; `failed` e `canceled` guardam a fase em que o job parou (A-12). */
export function finalFields(
  status: 'done' | 'failed' | 'canceled',
  phase: EnrichPhase | null,
): { status: typeof status; phase: EnrichPhase | null } {
  return { status, phase: status === 'done' ? null : phase };
}

/** `stalled`: job ativo cuja maior atividade (`updatedAt` ou `heartbeatAt`) tem mais de 180 s. */
export function isStalled(
  job: { status: JobStatus; updatedAt: Date; heartbeatAt: Date | null },
  now: Date,
): boolean {
  if (!isActiveStatus(job.status)) return false;
  const last = Math.max(job.updatedAt.getTime(), job.heartbeatAt?.getTime() ?? 0);
  return now.getTime() - last > STALLED_AFTER_MS;
}

/** Quantas vezes o lote já falhou em sequência: a espera até a próxima repetição, ou `null` (acabaram as repetições). */
export const retryDelaySeconds = (attempts: number): number | null =>
  RETRY_DELAYS_SECONDS[attempts - 1] ?? null;

/** Falha terminal ou tentativas esgotadas: o job termina; senão o lote é repetido. */
export function failureDecision(input: {
  attempts: number;
  maxAttempts: number;
  terminal: boolean;
}): 'fail' | 'retry' {
  return input.terminal || input.attempts >= input.maxAttempts ? 'fail' : 'retry';
}

const ERROR_MESSAGES: Record<EnrichErrorCode, string> = {
  AI_PROVIDER_ERROR: 'O serviço de IA não respondeu. Os itens que faltam continuam para conferir.',
  AI_TIMEOUT: 'O serviço de IA demorou demais. Os itens que faltam continuam para conferir.',
  JOB_STALLED: 'O processamento parou três vezes seguidas.',
  QUEUE_UNAVAILABLE: 'Não foi possível continuar o processamento.',
  INTERNAL: 'Erro inesperado no processamento.',
};

/** O `error` do job com o texto em pt-BR do código (A-25). */
export const enrichError = (code: EnrichErrorCode, phase: EnrichPhase | null): EnrichError => ({
  code,
  phase,
  message: ERROR_MESSAGES[code],
});

/** O que a varredura do reconciliador sabe de um job ativo. */
export interface ReconcileFacts {
  heartbeatAt: Date | null;
  updatedAt: Date;
  cancelRequestedAt: Date | null;
  batchAttempts: number;
  documentDeleted: boolean;
}

export type ReconcileAction =
  | 'none'
  | 'cancel'
  | 'fail_stalled'
  | 'republish_dead'
  | 'republish_lost';

const ageSeconds = (since: Date, now: Date): number => (now.getTime() - since.getTime()) / 1000;

/**
 * A decisão da varredura (`a3-job-enriquecimento.html#s6-4`): encarte excluído ou parada pedida sem lote em execução
 * (ou com o lote morto) fecha `canceled`, e com o lote vivo é ele quem fecha, depois de gravar; lote em execução sem batimento além do prazo sobe `batchAttempts` e, na última
 * tentativa, falha com `JOB_STALLED`, senão é republicado; lote publicado e não assumido há mais de 300 s é republicado
 * sem contar tentativa.
 */
export function reconcileAction(
  facts: ReconcileFacts,
  now: Date,
  config: Pick<FlyerProEnrichConfig, 'staleSeconds' | 'maxAttempts'>,
): ReconcileAction {
  const running = facts.heartbeatAt !== null;
  const dead = running && ageSeconds(facts.heartbeatAt as Date, now) > config.staleSeconds;
  // Encarte excluído e parada pedida valem o mesmo: com um lote vivo, ele grava o que conferiu e fecha o job.
  const stopping = facts.documentDeleted || facts.cancelRequestedAt !== null;
  if (stopping && (!running || dead)) return 'cancel';
  if (dead) {
    return facts.batchAttempts + 1 >= config.maxAttempts ? 'fail_stalled' : 'republish_dead';
  }
  const lost = !running && ageSeconds(facts.updatedAt, now) > LOST_BATCH_AFTER_SECONDS;
  return lost ? 'republish_lost' : 'none';
}

/** Contagens de um lote gravado, por fase: só o que o `UPDATE` afetou, mais os itens lidos (`visited`). */
export type PhaseCounts = Record<string, number>;

const ZERO_COUNTS: Record<EnrichStep, PhaseCounts> = {
  categorize: { visited: 0, applied: 0, suggested: 0, unchanged: 0 },
  spellcheck: { visited: 0, suggested: 0, clean: 0 },
  image_match: { visited: 0, applied: 0, review: 0, notFound: 0, eanPending: 0 },
};

/** `result` com a fase somada às contagens do lote (a fase nasce zerada, sem `skipped`). */
export function addCounts(
  result: EnrichResult,
  phase: EnrichStep,
  counts: PhaseCounts,
): EnrichResult {
  const current = (result[phase] ?? { ...ZERO_COUNTS[phase], skipped: null }) as PhaseCounts;
  const summed = Object.fromEntries(
    Object.keys(ZERO_COUNTS[phase]).map((key) => [key, (current[key] ?? 0) + (counts[key] ?? 0)]),
  );
  return { ...result, [phase]: { ...current, ...summed } };
}

/** `result` com a fase marcada como pulada (nenhum item tocado). */
export function markSkipped(result: EnrichResult, phase: EnrichStep): EnrichResult {
  const current = (result[phase] ?? { ...ZERO_COUNTS[phase], skipped: null }) as PhaseCounts;
  return { ...result, [phase]: { ...current, skipped: 'AI_DISABLED' } };
}

/**
 * `timing.<fase> = { batches, totalMs, maxMs }`: só os lotes gravados com pelo menos um item entram (A-18). O lote que
 * falhou no provedor e o que fechou a fase sem item não contam.
 */
export function addTiming(
  result: EnrichResult,
  phase: EnrichStep,
  batch: { items: number; durationMs: number },
): EnrichResult {
  if (batch.items <= 0) return result;
  const before = result.timing?.[phase] ?? { batches: 0, totalMs: 0, maxMs: 0 };
  const timing = {
    batches: before.batches + 1,
    totalMs: before.totalMs + batch.durationMs,
    maxMs: Math.max(before.maxMs, batch.durationMs),
  };
  return { ...result, timing: { ...result.timing, [phase]: timing } };
}

/** `models` com o modelo da fase que rodou. */
export const withModel = (
  models: EnrichModels | null,
  phase: EnrichStep,
  model: string,
): EnrichModels => ({ ...models, [phase]: model });
