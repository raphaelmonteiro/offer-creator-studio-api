import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Trilha de auditoria do módulo de comerciais — espelho do padrão
 * animation_task_events para as entidades mc_* (plano-comerciais §6.1):
 * fonte do timeline da UI e do replay SSE (`id` bigserial é o cursor de
 * replay por usuário — daí o índice (userId, id)).
 */
@Entity('mc_events')
@Index(['userId', 'id'])
export class McEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column()
  userId: string;

  /** A qual entidade o evento se refere. */
  @Column({ type: 'varchar', length: 10 })
  refKind: 'kit' | 'project' | 'scene' | 'step';

  @Column({ type: 'uuid' })
  refId: string;

  /** Natureza do evento (ex.: 'transition', 'note', 'moderation'). */
  @Column({ type: 'text' })
  kind: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  fromStatus: string | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  toStatus: string | null;

  @Column({ type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}
