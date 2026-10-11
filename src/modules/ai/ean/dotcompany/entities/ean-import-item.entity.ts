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
import type { ImportItemResult, ImportItemStatus } from '../dotcompany.types';
import { EanImportJob } from './ean-import-job.entity';

/** Uma linha do cadastro (ou um produto do encarte) a resolver na DotCompany. */
@Entity('ean_import_items')
// Espelham a migration (o `synchronize` de dev apagaria o que não está declarado).
@Index('IDX_ean_import_items_job_status', ['jobId', 'status'])
@Index('IDX_ean_import_items_job_result', ['jobId', 'result'])
export class EanImportItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  jobId: string;

  @ManyToOne(() => EanImportJob, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId', foreignKeyConstraintName: 'FK_ean_import_items_job' })
  job?: EanImportJob;

  @Column({ type: 'int' })
  rowNumber: number;

  /** EAN como veio (normalizado só para dígitos); a validade é decidida no processamento. */
  @Column({ type: 'varchar', length: 32 })
  ean: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: ImportItemStatus;

  @Column({ type: 'varchar', length: 24, nullable: true })
  result: ImportItemResult | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  galleryImageId: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
