import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { FlyerProDocument } from './flyer-pro-document.entity';
import { FlyerProImport } from './flyer-pro-import.entity';

/**
 * Item de oferta do encarte (M1). O `id` é gerado no front, por isso a chave não tem padrão. Os nomes de chave e de
 * índice são os da migration. `galleryImageId` é referência lógica (a foto pode ser excluída; o item guarda `imageUrl`).
 * `updatedAt` é o cursor da leitura incremental: toda escrita em item grava o carimbo por SQL, sem `@UpdateDateColumn`.
 * `importId` (M2) é a importação que criou o item, gravada só na inserção; apagar a importação deixa o campo nulo.
 */
@Entity('flyer_pro_items')
@Index('IDX_flyer_pro_items_document_position', ['documentId', 'position'])
@Index('IDX_flyer_pro_items_document_updated', ['documentId', 'updatedAt'])
@Index('IDX_flyer_pro_items_gallery_image', ['galleryImageId'], {
  where: '"galleryImageId" IS NOT NULL',
})
@Index('IDX_flyer_pro_items_import', ['importId'], { where: '"importId" IS NOT NULL' })
export class FlyerProItem {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_flyer_pro_items' })
  id: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @ManyToOne(() => FlyerProDocument, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'documentId', foreignKeyConstraintName: 'FK_flyer_pro_items_document' })
  document?: FlyerProDocument;

  @Column({ type: 'integer' })
  position: number;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceName: string | null;

  @Column({ type: 'jsonb' })
  price: Record<string, unknown>;

  @Column({ type: 'varchar', length: 8 })
  unit: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 12, nullable: true })
  categorySource: string | null;

  @Column({ type: 'jsonb', nullable: true })
  categoryReview: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  isAlcoholic: boolean;

  @Column({ type: 'varchar', length: 14, nullable: true })
  ean: string | null;

  @Column({ type: 'uuid', nullable: true })
  galleryImageId: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  imageUrl: string | null;

  @Column({ type: 'integer', nullable: true })
  imageWidth: number | null;

  @Column({ type: 'integer', nullable: true })
  imageHeight: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  imageOrigin: string | null;

  @Column({ type: 'varchar', length: 16, default: 'none' })
  imageStatus: string;

  @Column({ type: 'jsonb', nullable: true })
  imageReview: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  spellReview: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  imported: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  importId: string | null;

  @ManyToOne(() => FlyerProImport, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'importId', foreignKeyConstraintName: 'FK_flyer_pro_items_import' })
  import?: FlyerProImport;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
