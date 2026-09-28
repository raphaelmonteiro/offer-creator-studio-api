import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  AiDecisionRecord,
  EanCandidateRecord,
  EanMatchItemStatus,
  EanReferenceRecord,
  EanReviewReason,
  HumanDecisionRecord,
  JudgmentRecord,
} from '../ean-match.types';
import type { ProductMetadata } from '../../metadata/product-metadata.schema';
import { EanMatchJob } from './ean-match-job.entity';

/** Uma linha da planilha, com toda a evidência que levou à decisão. */
@Entity('ean_match_items')
@Index('IDX_ean_match_items_job_status', ['jobId', 'status'])
@Index('IDX_ean_match_items_ean', ['ean'])
export class EanMatchItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  jobId: string;

  @ManyToOne(() => EanMatchJob, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId', foreignKeyConstraintName: 'FK_ean_match_items_job' })
  job?: EanMatchJob;

  @Column({ type: 'int' })
  rowNumber: number;

  @Column({ type: 'varchar', length: 14 })
  ean: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  status: EanMatchItemStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reviewReason: EanReviewReason | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  candidates: EanCandidateRecord[];

  @Column({ type: 'jsonb', nullable: true })
  reference: EanReferenceRecord | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  judgments: JudgmentRecord[];

  @Column({ type: 'jsonb', nullable: true })
  aiDecision: AiDecisionRecord | null;

  @Column({ type: 'jsonb', nullable: true })
  humanDecision: HumanDecisionRecord | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  writtenImageIds: string[];

  /** Metadata de cada imagem antes da gravação, por id — base da reversão. */
  @Column({ type: 'jsonb', nullable: true })
  previousMetadata: Record<string, ProductMetadata> | null;

  @Column({ type: 'boolean', default: false })
  isCalibration: boolean;

  @Column({ type: 'numeric', precision: 10, scale: 4, default: 0 })
  costUsd: string;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
