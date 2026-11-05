import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from './numeric.transformer';

/**
 * Cena de template (estágio 3 do Template Pro): o contêiner de versões, mensagens e arquivos de um
 * template em criação. `revision` é o lock otimista (`expectedRevision` → 409 `REVISION_CONFLICT`);
 * `createdByUserId` é referência lógica a `users.id` (sem FK e sem permissão por usuário, D-6).
 * `currentVersionId` não tem FK (a versão aponta de volta para a cena).
 */
@Entity('template_scenes')
@Index('IDX_template_scenes_deleted_updated', ['deletedAt', 'updatedAt'])
export class TemplateScene {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_template_scenes' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 64 })
  formatId: string;

  @Column({ type: 'numeric', precision: 8, scale: 2, transformer: numericTransformer })
  artWidthCm: number;

  @Column({ type: 'numeric', precision: 8, scale: 2, transformer: numericTransformer })
  artHeightCm: number;

  @Column({ type: 'int' })
  widthPx: number;

  @Column({ type: 'int' })
  heightPx: number;

  @Column({ type: 'numeric', precision: 10, scale: 4, transformer: numericTransformer })
  pixelsPerCm: number;

  @Column({ type: 'uuid', nullable: true })
  currentVersionId: string | null;

  @Column({ type: 'int', default: 0 })
  revision: number;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  /** Estágios 5 e 7: nulos até lá. */
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedTemplateId: string | null;

  @Column({ type: 'uuid', nullable: true })
  derivedFromSceneId: string | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  totalCostUsd: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;
}
