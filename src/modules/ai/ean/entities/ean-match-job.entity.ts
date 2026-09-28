import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { EanMatchJobStatus } from '../ean-match.types';

/** Uma planilha de cliente enviada para vínculo EAN→galeria. */
@Entity('ean_match_jobs')
export class EanMatchJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: EanMatchJobStatus;

  @Column({ type: 'varchar', nullable: true })
  fileName: string | null;

  @Column({ type: 'varchar', length: 64 })
  fileHash: string;

  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ type: 'int', default: 0 })
  totalRows: number;

  @Column({ type: 'int', default: 0 })
  discardedRows: number;

  @Column({ type: 'numeric', precision: 10, scale: 4, default: 0 })
  costUsd: string;

  @Column({ type: 'numeric', precision: 10, scale: 4, default: 0 })
  costCapUsd: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  judgeVersion: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
