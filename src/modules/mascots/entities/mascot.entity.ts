import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Estados do mascote (spike §6). `segmenting` e `needs_review` já existem no
 * schema porque pertencem ao preparo do rig (Fase 3); nesta entrega só
 * `draft`, `ready` e `failed` são efetivamente atingidos.
 */
export type MascotStatus = 'draft' | 'segmenting' | 'needs_review' | 'ready' | 'failed';

@Entity('mascots')
@Index('IDX_mascots_user_status', ['userId', 'status', 'createdAt'])
export class Mascot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /**
   * PNG original enviado pelo usuário. IMUTÁVEL — nenhuma etapa do produto
   * reescreve este arquivo (spike §8.1, restrição de identidade).
   */
  @Column({ type: 'varchar' })
  sourceImageUrl: string;

  /** RGBA sem fundo — derivado do original, nunca o substitui. */
  @Column({ type: 'varchar', nullable: true })
  cutoutUrl: string | null;

  /** Miniatura para listagens/canvas. Derivada. */
  @Column({ type: 'varchar', nullable: true })
  previewUrl: string | null;

  /** Reservado para a Fase 3 (rig 2D). Não é preenchido nesta entrega. */
  @Column({ type: 'jsonb', default: () => `'{}'` })
  rig: Record<string, unknown>;

  /** Rig é imutável depois de `ready`; editar incrementa esta versão (§6.1). */
  @Column({ type: 'int', default: 1 })
  rigVersion: number;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: MascotStatus;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'boolean', default: false })
  hasAlpha: boolean;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  metadata: Record<string, unknown>;

  /** Aceite de titularidade/licença da marca — requisito, não aviso (risco 4). */
  @Column({ type: 'timestamptz', nullable: true })
  rightsConfirmedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  rightsConfirmedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
