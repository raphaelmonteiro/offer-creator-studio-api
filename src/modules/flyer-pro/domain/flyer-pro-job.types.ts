/** Os tipos do job de enriquecimento (`a1-modelo-de-dados.html#s7-6`): o que fica em `steps`, `cursor`, `result` e `error`. */

/** As três fases que o pedido escolhe, na ordem em que o job as roda. */
export type EnrichStep = 'categorize' | 'spellcheck' | 'image_match';

/** `image_ean_retry` é a passada de EAN pendente da change 29; esta change só a reserva no tipo. */
export type EnrichPhase = EnrichStep | 'image_ean_retry';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

/** Fase pulada porque o provedor a declarou indisponível; fase não pedida simplesmente não aparece em `result`. */
export type EnrichSkipReason = 'AI_DISABLED' | null;

export interface EnrichCursor {
  /** 1 a 3: rodada de conferência dos itens que chegaram durante o job. */
  round: number;
  /** 0 a 3: passada de repetição de EAN pendente (change 29). */
  pass: number;
  /** Último item visitado na fase, por `(position, id)`. */
  position: number | null;
  id: string | null;
}

export interface EnrichTiming {
  batches: number;
  totalMs: number;
  maxMs: number;
}

export interface EnrichResult {
  categorize?: {
    visited: number;
    applied: number;
    suggested: number;
    unchanged: number;
    skipped: EnrichSkipReason;
  };
  spellcheck?: { visited: number; suggested: number; clean: number; skipped: EnrichSkipReason };
  image_match?: {
    visited: number;
    applied: number;
    review: number;
    notFound: number;
    eanPending: number;
    skipped: EnrichSkipReason;
    /** Presente (`true`) quando a fase rodou sem a busca por nome (só EAN e nome já escolhido); change 29. */
    nameSearchUnavailable?: true;
    /** Itens que ficaram com `eanStatus = 'budget_blocked'` e seguiram pela busca por nome; change 29. */
    eanBudgetBlocked?: number;
  };
  /** Instrumentação (U0.10): por fase, quantos lotes foram gravados e quanto duraram. */
  timing?: Partial<Record<EnrichPhase, EnrichTiming>>;
}

export type EnrichErrorCode =
  | 'AI_PROVIDER_ERROR'
  | 'AI_TIMEOUT'
  | 'JOB_STALLED'
  | 'QUEUE_UNAVAILABLE'
  | 'INTERNAL';

export interface EnrichError {
  code: EnrichErrorCode;
  phase: EnrichPhase | null;
  /** pt-BR, para a tela. */
  message: string;
}

/** O modelo usado em cada fase que rodou (`"mock"` no simulado). */
export type EnrichModels = Partial<Record<EnrichPhase, string>>;
