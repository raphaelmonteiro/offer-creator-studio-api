import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McAspectRatio, McProjectOptions, McScript } from '../domain/mc-types';
import type { McQualityState } from '../domain/mc-quality';
import { McCharacterKit } from './mc-character-kit.entity';

/**
 * 1 comercial (plano-comerciais §6.1): draft → scripting → storyboard_review
 * (GATE) → generating → needs_attention | assembling → succeeded|failed|canceled.
 * `script` (jsonb) é a FONTE DE VERDADE do conteúdo; mc_scenes/mc_steps são a
 * materialização executável dele após a aprovação do storyboard.
 */
@Entity('mc_projects')
@Index(['userId', 'status', 'createdAt'])
export class McProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  kitId: string;

  @ManyToOne(() => McCharacterKit, { nullable: false })
  @JoinColumn({ name: 'kitId' })
  kit: McCharacterKit;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 20, default: McProjectStatus.DRAFT })
  status: McProjectStatus;

  /** Executor congelado por projeto (ADR-001 §5): 1 = legado, 2 = pipeline v2. Nunca muda em andamento. */
  @Column({ type: 'int', default: 1 })
  pipelineVersion: number;

  /** Revisão editorial (v2): controle otimista + vínculo da aprovação. Incrementa a cada edição. */
  @Column({ type: 'int', default: 0 })
  revision: number;

  /** Estado do pipeline v2 (manifestos, aprovação, orçamentos, timeline) — NULL no legado. */
  @Column({ type: 'jsonb', nullable: true })
  quality: McQualityState | null;

  @Column({ type: 'text' })
  briefing: string;

  @Column({ type: 'jsonb', nullable: true })
  script: McScript | null;

  @Column({ type: 'varchar', length: 10, default: '9:16' })
  aspectRatio: McAspectRatio;

  @Column({ type: 'int' })
  targetDurationS: number;

  /**
   * Preferências de montagem (v1-B1): trilha, legendas e produtos do catálogo
   * que viram selos. UMA coluna jsonb em vez de 3 colunas novas — é um bloco
   * de opções que tende a crescer (SFX, marca d'água) e nada aqui é chave de
   * busca/hash. NULL nos projetos anteriores ao bloco: `resolveProjectOptions`
   * aplica os defaults (música on, legendas on, sem produtos).
   */
  @Column({ type: 'jsonb', nullable: true })
  options: McProjectOptions | null;

  @Column({ type: 'uuid', nullable: true })
  soundtrackAssetId: string | null;

  @Column({ type: 'uuid', nullable: true })
  finalAssetId: string | null;

  /** Reserva na aprovação do storyboard + mini-reserva na criação (plano §6.7). */
  @Column({ type: 'int', default: 0 })
  reservedCredits: number;

  @Column({ type: 'int', default: 0 })
  consumedCredits: number;

  /** Custo real somado dos steps — telemetria de margem (plano §6.7). */
  @Column({ type: 'numeric', precision: 10, scale: 4, default: 0 })
  providerCostUsd: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  /** Resultado auditado da moderação do briefing/roteiro (plano §6.8). */
  @Column({ type: 'jsonb', nullable: true })
  moderation: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  /** Aprovação do storyboard (GATE humano). */
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
