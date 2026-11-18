import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { numericTransformer } from '../../../shared/numeric.transformer';
import type {
  EnrichCursor,
  EnrichError,
  EnrichModels,
  EnrichPhase,
  EnrichResult,
  EnrichStep,
  JobStatus,
} from '../domain/flyer-pro-job.types';
import { FlyerProDocument } from './flyer-pro-document.entity';

/**
 * O job de enriquecimento do encarte (M3): fotos, categorias e ortografia em lotes. Os nomes de chave e de índice são
 * os da migration `CreateFlyerProJobs`, inclusive o filtro do índice único parcial (um job ativo por encarte).
 * `batchSeq` é a ficha do lote e `heartbeatAt` o batimento do lote em execução. `id` tem o padrão `gen_random_uuid()` da
 * migration, e `createdByUserId` é referência lógica, sem FK. `updatedAt` e os demais carimbos são gravados por SQL.
 */
@Entity('flyer_pro_jobs')
@Index('UQ_flyer_pro_jobs_document_active', ['documentId'], {
  unique: true,
  where: `"status" IN ('queued', 'running')`,
})
@Index('IDX_flyer_pro_jobs_document_created', ['documentId', 'createdAt'])
export class FlyerProJob {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_flyer_pro_jobs',
    default: () => 'gen_random_uuid()',
  })
  id: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @ManyToOne(() => FlyerProDocument, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'documentId', foreignKeyConstraintName: 'FK_flyer_pro_jobs_document' })
  document?: FlyerProDocument;

  /** Na ordem fixa das fases, sem repetição. */
  @Column({ type: 'jsonb' })
  steps: EnrichStep[];

  @Column({ type: 'varchar', length: 12, default: 'queued' })
  status: JobStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phase: EnrichPhase | null;

  @Column({ type: 'jsonb', nullable: true })
  cursor: EnrichCursor | null;

  @Column({ type: 'integer', default: 0 })
  total: number;

  @Column({ type: 'integer', default: 0 })
  processed: number;

  /** `null` vale "todos os itens do encarte". */
  @Column({ type: 'jsonb', nullable: true })
  itemIds: string[] | null;

  @Column({ type: 'boolean', default: true })
  onlyMissing: boolean;

  @Column({ type: 'boolean', default: true })
  autoApply: boolean;

  @Column({ type: 'jsonb', default: () => `'{}'` })
  result: EnrichResult;

  @Column({ type: 'jsonb', nullable: true })
  error: EnrichError | null;

  @Column({ type: 'jsonb', nullable: true })
  models: EnrichModels | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    nullable: true,
    transformer: numericTransformer,
  })
  costUsd: number | null;

  @Column({ type: 'integer', default: 0 })
  batchSeq: number;

  /** Padrão como expressão: o TypeORM escreveria `'0'::smallint` para o `smallint`, e a migration diz `DEFAULT 0`. */
  @Column({ type: 'smallint', default: () => '0' })
  batchAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  heartbeatAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelRequestedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
