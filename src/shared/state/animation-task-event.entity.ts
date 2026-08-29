import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/** Trilha de auditoria de transições (TDD §3.6) — fonte do timeline da UI e do replay SSE. */
@Entity('animation_task_events')
export class AnimationTaskEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column()
  @Index()
  taskId: string;

  @Column()
  userId: string;

  @Column({ type: 'varchar', length: 10, default: 'task' })
  kind: 'task' | 'render';

  @Column({ type: 'varchar', length: 30 })
  fromStatus: string;

  @Column({ type: 'varchar', length: 30 })
  toStatus: string;

  @Column({ type: 'jsonb', default: {} })
  detail: Record<string, unknown>;

  @CreateDateColumn()
  @Index()
  createdAt: Date;
}
