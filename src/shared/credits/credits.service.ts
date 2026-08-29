import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AiCreditLedgerEntry, LedgerReason } from './ai-credit-ledger.entity';

export class InsufficientCreditsError extends HttpException {
  constructor(balance: number, required: number) {
    super(
      {
        code: 'INSUFFICIENT_CREDITS',
        message: `Créditos insuficientes: saldo ${balance}, necessário ${required}`,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/** Famílias de cobrança — cada uma tem seu próprio interruptor no .env. */
export type CreditFamily = 'animations' | 'commercials';

/**
 * Cobrança de créditos POR FAMÍLIA, desligada por padrão nas duas:
 *
 * - `animations`  → `AI_CREDITS_ENABLED`  (comportamento idêntico ao flag
 *   global antigo; chamadores existentes usam o default e não mudam).
 * - `commercials` → `MC_CREDITS_ENABLED`  (default false POR ENQUANTO: o
 *   plano §6.7 pede ledger ligado desde o dia 1 para esta família, mas o
 *   RELIGAMENTO é decisão de go-live comercial — basta `MC_CREDITS_ENABLED=true`
 *   no .env da VM, nada mais precisa mudar).
 *
 * O ledger continua implementado e testado independente dos flags.
 */
export function creditsEnabled(family: CreditFamily = 'animations'): boolean {
  if (family === 'commercials') {
    return process.env.MC_CREDITS_ENABLED === 'true';
  }
  return process.env.AI_CREDITS_ENABLED === 'true';
}

/**
 * Ledger de créditos (TDD §3.4): reserva total na criação da task, consumo por
 * etapa, estorno parcial/total. Todas as operações recebem o EntityManager da
 * transação chamadora — débito e enqueue são atômicos (pg-boss é Postgres).
 */
@Injectable()
export class CreditsService {
  async getBalance(manager: EntityManager, userId: string): Promise<number> {
    const row = await manager
      .createQueryBuilder(AiCreditLedgerEntry, 'l')
      .select('COALESCE(SUM(l.delta), 0)', 'balance')
      .where('l.userId = :userId', { userId })
      .getRawOne<{ balance: string }>();
    return Number(row?.balance ?? 0);
  }

  /**
   * Reserva (débito) do custo total do pipeline. Lança 402 se o saldo não cobre.
   * O SELECT de saldo e o INSERT rodam na mesma transação; lock por advisory
   * lock do usuário evita corrida entre duas reservas simultâneas.
   */
  async reserve(
    manager: EntityManager,
    userId: string,
    taskId: string,
    amount: number,
  ): Promise<void> {
    if (amount < 0) throw new Error('Reserva não pode ser negativa');
    if (amount === 0) return;
    await this.lockUser(manager, userId);
    const balance = await this.getBalance(manager, userId);
    if (balance < amount) throw new InsufficientCreditsError(balance, amount);
    await this.append(manager, userId, -amount, 'task_reserve', taskId);
  }

  /**
   * Estorno na falha/cancelamento: devolve `reserved - consumed` (TDD §3.4
   * regras 3–4). Idempotente: se já houve estorno para a task, vira no-op.
   */
  async refundUnconsumed(
    manager: EntityManager,
    userId: string,
    taskId: string,
    reservedCredits: number,
    consumedCredits: number,
  ): Promise<number> {
    const refund = reservedCredits - consumedCredits;
    if (refund <= 0) return 0;
    await this.lockUser(manager, userId);
    const existing = await manager.count(AiCreditLedgerEntry, {
      where: [
        { taskId, reason: 'task_refund' },
        { taskId, reason: 'task_refund_partial' },
      ],
    });
    if (existing > 0) return 0;
    const reason: LedgerReason = consumedCredits > 0 ? 'task_refund_partial' : 'task_refund';
    await this.append(manager, userId, refund, reason, taskId);
    return refund;
  }

  async grant(
    manager: EntityManager,
    userId: string,
    amount: number,
    reason: LedgerReason = 'monthly_grant',
  ): Promise<void> {
    if (amount <= 0) throw new Error('Concessão deve ser positiva');
    await this.append(manager, userId, amount, reason, null);
  }

  private async append(
    manager: EntityManager,
    userId: string,
    delta: number,
    reason: LedgerReason,
    taskId: string | null,
  ): Promise<void> {
    await manager.insert(AiCreditLedgerEntry, { userId, delta, reason, taskId });
  }

  /** Advisory lock transacional por usuário — serializa reservas/estornos concorrentes. */
  private async lockUser(manager: EntityManager, userId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`credits:${userId}`]);
  }
}
