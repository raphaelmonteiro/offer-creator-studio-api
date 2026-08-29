import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from './mc-project.entity';
import { McScene } from './mc-scene.entity';

/**
 * Step — a unidade de execução/custo/cache (plano-comerciais §6.1):
 * 1 job de fila = 1 step curto (§6.4). `inputHash` é a chave de cache (§6.3);
 * o índice parcial em WHERE status='succeeded' é o índice de lookup do cache.
 * Steps de projeto (script/assembly) têm sceneId null.
 */
@Entity('mc_steps')
@Index(['projectId', 'status'])
@Index(['provider', 'providerJobId'])
@Index('IDX_mc_steps_input_hash_succeeded', ['inputHash'], { where: `"status" = 'succeeded'` })
export class McStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectId: string;

  @ManyToOne(() => McProject, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: McProject;

  @Column({ type: 'uuid', nullable: true })
  sceneId: string | null;

  @ManyToOne(() => McScene, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sceneId' })
  scene: McScene | null;

  /** Geração da cena a que o step pertence — o scheduler ignora gerações antigas. */
  @Column({ type: 'int', nullable: true })
  sceneGeneration: number | null;

  @Column({ type: 'varchar', length: 20 })
  type: McStepType;

  @Column({ type: 'varchar', length: 20, default: McStepStatus.PENDING })
  status: McStepStatus;

  /** sha256 canônico dos inputs (domain/input-hash.ts) — chave de cache (§6.3). */
  @Column({ type: 'text' })
  inputHash: string;

  @Column({ type: 'text', nullable: true })
  provider: string | null;

  /** Submit que encontra providerJobId gravado vira poll (idempotência, §6.4). */
  @Column({ type: 'text', nullable: true })
  providerJobId: string | null;

  @Column({ type: 'uuid', nullable: true })
  outputAssetId: string | null;

  @Column({ type: 'int', default: 0 })
  costCredits: number;

  /** Custo real do provider por step — calibração de preço (plano §8/§6.7). */
  @Column({ type: 'numeric', precision: 10, scale: 4, nullable: true })
  providerCostUsd: string | null;

  /** Classe de erro (transient|content_policy|provider_timeout|quota|internal, §6.4). */
  @Column({ type: 'varchar', length: 30, nullable: true })
  errorClass: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
