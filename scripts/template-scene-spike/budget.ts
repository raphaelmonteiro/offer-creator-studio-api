import type { Ledger } from './ledger';
import type { CallKind } from './types';

export type StopCode =
  | 'budget'
  | 'quota'
  | 'auth'
  | 'model'
  | 'mask_refused'
  | 'failures'
  | 'anomalous_cost'
  | 'interrupted';

/** Parada do spike (P1 a P5). O estado e o relatório parcial são gravados por quem captura. */
export class StopError extends Error {
  constructor(
    readonly code: StopCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BudgetOptions {
  budgetUsd: number;
  initialReserveUsd: number;
  maxCallUsd: number;
  /** Reserva inicial própria de um tipo de chamada com preço fixo (ex.: Replicate). */
  fixedReserves?: Partial<Record<CallKind, number>>;
}

export type Arm = 'mask' | 'markup';

const FAILURE_LIMIT = 5;
const REFUSAL_LIMIT = 2;
const RESERVE_FACTOR = 1.5;

/** Disjuntor de gasto e contadores de falha (P1, P3, P4, P5). O gasto vem sempre do ledger em disco. */
export class Budget {
  private consecutiveFailures = 0;
  private readonly refusals: Record<Arm, number> = { mask: 0, markup: 0 };
  private markupOff = false;

  constructor(
    private readonly ledger: Ledger,
    private readonly options: BudgetOptions,
  ) {}

  spentUsd(): number {
    return this.ledger.spentUsd();
  }

  /** 1,5x o maior custo observado do tipo, ou a reserva inicial enquanto não houver observação. */
  reserveFor(kind: CallKind): number {
    const observed = this.ledger.maxCostOf(kind);
    if (observed != null) return observed * RESERVE_FACTOR;
    return this.options.fixedReserves?.[kind] ?? this.options.initialReserveUsd;
  }

  /** P1: para antes da chamada se o gasto acumulado mais a reserva passar do teto. */
  guard(kind: CallKind): void {
    const spent = this.spentUsd();
    const reserve = this.reserveFor(kind);
    if (spent + reserve > this.options.budgetUsd) {
      throw new StopError(
        'budget',
        `Orçamento atingido: gasto US$ ${spent.toFixed(2)} + reserva US$ ${reserve.toFixed(2)} passa do teto de US$ ${this.options.budgetUsd.toFixed(2)}`,
      );
    }
  }

  /** P5: chamada acima do teto por chamada. */
  checkCallCost(costUsd: number): void {
    if (costUsd > this.options.maxCallUsd) {
      throw new StopError(
        'anomalous_cost',
        `Custo anômalo: uma chamada custou US$ ${costUsd.toFixed(2)} (teto por chamada US$ ${this.options.maxCallUsd.toFixed(2)}); confira tamanho e qualidade`,
      );
    }
  }

  noteSuccess(arm?: Arm): void {
    this.consecutiveFailures = 0;
    if (arm) this.refusals[arm] = 0;
  }

  /** P4 e P3. `refusedArm` é o parâmetro citado por um 400. */
  noteFailure(refusedArm?: Arm): void {
    this.consecutiveFailures += 1;
    if (refusedArm) {
      this.refusals[refusedArm] += 1;
      if (this.refusals[refusedArm] >= REFUSAL_LIMIT) this.onRefusalLimit(refusedArm);
    }
    if (this.consecutiveFailures >= FAILURE_LIMIT) {
      throw new StopError(
        'failures',
        `${FAILURE_LIMIT} chamadas seguidas falharam após as retentativas`,
      );
    }
  }

  private onRefusalLimit(arm: Arm): void {
    if (arm === 'mask') {
      throw new StopError(
        'mask_refused',
        'A API recusou `mask` em duas edições seguidas: a edição mascarada não está disponível',
      );
    }
    this.markupOff = true;
  }

  isMarkupDisabled(): boolean {
    return this.markupOff;
  }
}
