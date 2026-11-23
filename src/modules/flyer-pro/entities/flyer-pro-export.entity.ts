import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { numericTransformer } from '../../../shared/numeric.transformer';
import type { ExportFormat, ExportOptions, ExportPreflightCount } from '../domain/flyer-pro.types';
import { FlyerProDocument } from './flyer-pro-document.entity';

/**
 * Uma exportação registrada de um encarte (M4). O `id` é gerado no front (o registro é idempotente por ele), por isso a
 * chave não tem padrão. Os nomes de chave e de índice são os da migration `CreateFlyerProExports`. Nesta fase o arquivo
 * não é guardado: `filePath` fica nulo e `fileState` fica `not_stored` (PU-50). `fileSize` é `bigint`, que o driver
 * devolve como texto; o transformador o lê como número. `createdByUserId` é referência lógica, sem FK. A linha é
 * imutável depois de gravada.
 */
@Entity('flyer_pro_exports')
@Index('IDX_flyer_pro_exports_document_created', ['documentId', 'createdAt'])
export class FlyerProExport {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_flyer_pro_exports' })
  id: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @ManyToOne(() => FlyerProDocument, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'documentId', foreignKeyConstraintName: 'FK_flyer_pro_exports_document' })
  document?: FlyerProDocument;

  @Column({ type: 'integer' })
  documentRevision: number;

  @Column({ type: 'integer' })
  engineVersion: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  renderDigest: string | null;

  @Column({ type: 'varchar', length: 8 })
  format: ExportFormat;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  options: ExportOptions;

  @Column({ type: 'varchar', length: 200 })
  fileName: string;

  @Column({ type: 'bigint', nullable: true, transformer: numericTransformer })
  fileSize: number | null;

  @Column({ type: 'jsonb', nullable: true })
  preflight: ExportPreflightCount | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  filePath: string | null;

  @Column({ type: 'varchar', length: 16, default: 'not_stored' })
  fileState: string;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
