import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { BudgetDenyReason, ImportJobKind, ImportJobStatus } from '../dotcompany.types';

/** Importação de um cadastro de cliente (ou dos EANs pendentes de um encarte). */
@Entity('ean_import_jobs')
// Espelham a migration (o `synchronize` de dev apagaria o que não está declarado).
@Index('UQ_ean_import_jobs_fileHash', ['fileHash'], {
  unique: true,
  where: '"fileHash" IS NOT NULL',
})
@Index('IDX_ean_import_jobs_status', ['status'])
export class EanImportJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 8, default: 'file' })
  kind: ImportJobKind;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: ImportJobStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  waitReason: BudgetDenyReason | null;

  @Column({ type: 'timestamptz', nullable: true })
  waitUntil: Date | null;

  @Column({ type: 'varchar', nullable: true })
  fileName: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  fileHash: string | null;

  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ type: 'int', default: 0 })
  totalRows: number;

  /** Créditos DotCompany gastos (1 crédito = R$ 0,01). */
  @Column({ type: 'int', default: 0 })
  costCredits: number;

  /** Teto de créditos do job; 0 = sem teto próprio. */
  @Column({ type: 'int', default: 0 })
  costCapCredits: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
