import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { TaskStatus } from '../../../shared/state/task-state-machine';

@Entity('animation_tasks')
@Index(['userId', 'status', 'createdAt'])
@Index(['provider', 'providerJobId'])
export class AnimationTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column({ type: 'varchar', length: 30 })
  type: string;

  @Column({ type: 'varchar', length: 30, default: TaskStatus.QUEUED })
  status: TaskStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  provider: string | null;

  @Column({ nullable: true })
  providerJobId: string | null;

  @Column({ type: 'jsonb' })
  input: Record<string, unknown>;

  /** Etapas do pipeline com custo e estado próprio (TDD §3.2/§3.4). */
  @Column({ type: 'jsonb', default: [] })
  pipeline: Array<{
    key: string;
    label: string;
    costCredits: number;
    provider: string;
    status: 'pending' | 'running' | 'succeeded' | 'succeeded_cached' | 'failed';
    resultAssetId?: string;
  }>;

  @Column({ type: 'int', default: 0 })
  currentStepIndex: number;

  @Column({ nullable: true })
  resultAssetId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** Créditos reservados na criação (TDD §3.4 regra 1). */
  @Column({ type: 'int', default: 0 })
  reservedCredits: number;

  /** Créditos efetivamente consumidos por etapas concluídas. */
  @Column({ type: 'int', default: 0 })
  consumedCredits: number;

  @Column({ type: 'numeric', precision: 10, scale: 4, nullable: true })
  providerCostUsd: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
