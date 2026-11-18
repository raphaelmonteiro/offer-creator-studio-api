import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type {
  FlyerProImportRejectedRow,
  ImportFileKind,
  ImportMode,
} from '../domain/flyer-pro-import.types';
import { FlyerProDocument } from './flyer-pro-document.entity';

/**
 * Uma planilha importada num encarte (M2). O `id` é gerado no front (o registro viaja no mesmo `PATCH` dos itens que
 * apontam para ele), por isso a chave não tem padrão. Os nomes de chave e de índice são os da migration
 * `CreateFlyerProImports`. O arquivo original não é guardado; o registro é imutável depois de gravado. `createdByUserId`
 * é referência lógica, sem FK.
 */
@Entity('flyer_pro_imports')
@Index('IDX_flyer_pro_imports_document_hash', ['documentId', 'fileHash'])
export class FlyerProImport {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_flyer_pro_imports' })
  id: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @ManyToOne(() => FlyerProDocument, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'documentId', foreignKeyConstraintName: 'FK_flyer_pro_imports_document' })
  document?: FlyerProDocument;

  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'varchar', length: 8 })
  fileKind: ImportFileKind;

  @Column({ type: 'varchar', length: 64 })
  fileHash: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  detectedFormat: string | null;

  @Column({ type: 'varchar', length: 8 })
  mode: ImportMode;

  @Column({ type: 'integer' })
  rowCount: number;

  @Column({ type: 'integer' })
  acceptedCount: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  rejected: FlyerProImportRejectedRow[];

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
