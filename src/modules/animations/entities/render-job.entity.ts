import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { RenderStatus } from '../domain/task-state-machine';

@Entity('render_jobs')
@Index(['userId', 'status', 'createdAt'])
export class RenderJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column({ nullable: true })
  flyerId: string | null;

  @Column({ type: 'varchar', length: 20, default: RenderStatus.QUEUED })
  status: RenderStatus;

  @Column({ type: 'smallint', default: 0 })
  progressPct: number;

  @Column({ type: 'jsonb' })
  spec: Record<string, unknown>;

  @Column({ nullable: true })
  outputAssetId: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
