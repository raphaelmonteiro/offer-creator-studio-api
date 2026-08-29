import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type LedgerReason =
  | 'monthly_grant'
  | 'task_reserve'
  | 'task_refund'
  | 'task_refund_partial'
  | 'admin_adjust';

/**
 * Ledger append-only de créditos de IA (TDD §3.4).
 * Invariante: SUM(delta) por task terminal = -consumedCredits da task.
 */
@Entity('ai_credit_ledger')
export class AiCreditLedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ type: 'int' })
  delta: number;

  @Column({ type: 'varchar', length: 30 })
  reason: LedgerReason;

  @Column({ nullable: true })
  @Index()
  taskId: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
