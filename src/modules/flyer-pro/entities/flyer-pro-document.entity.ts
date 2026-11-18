import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import type { FlyerProFormat, FlyerProTemplateSnapshot } from '../domain/flyer-pro.types';

/** Uma fatia do estado do motor do front (frame, structure, card, assembly, exportPrefs): o servidor a trata como opaca. */
export type FlyerProSlice = Record<string, unknown>;

/**
 * O encarte do Encarte Pro (M1). Os nomes de chave e de índice são os da migration `CreateFlyerProDocuments`: o
 * `synchronize` de desenvolvimento compara por nome e apagaria um índice que a entidade não declarasse.
 *
 * `updatedAt` é coluna comum com `now()` (e não `@UpdateDateColumn`): é a hora da última gravação por `PATCH` (N4, change
 * 09), e nenhuma escrita automática do ORM, como a exclusão lógica, pode mexer nele (A-8). Só o N1 (na criação) e o N4
 * o gravam. `sceneId`, `createdByUserId` e `updatedByUserId` são referências lógicas, sem FK.
 */
@Entity('flyer_pro_documents')
@Index('IDX_flyer_pro_documents_list', ['updatedAt'], { where: '"deletedAt" IS NULL' })
@Index('IDX_flyer_pro_documents_client', ['clientId', 'updatedAt'])
@Index('UQ_flyer_pro_documents_creation_key', ['creationKey'], {
  unique: true,
  where: '"creationKey" IS NOT NULL',
})
export class FlyerProDocument {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_flyer_pro_documents' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'uuid' })
  clientId: string;

  @ManyToOne(() => Client, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'clientId', foreignKeyConstraintName: 'FK_flyer_pro_documents_client' })
  client?: Client;

  @Column({ type: 'uuid' })
  sceneId: string;

  @Column({ type: 'varchar', length: 8 })
  format: FlyerProFormat;

  @Column({ type: 'smallint' })
  pageCount: number;

  @Column({ type: 'boolean', default: false })
  pagesFrozen: boolean;

  @Column({ type: 'varchar', length: 16, default: 'products' })
  step: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  ui: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  templateSnapshot: FlyerProTemplateSnapshot;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  frame: FlyerProSlice;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  structure: FlyerProSlice;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  card: FlyerProSlice;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  assembly: FlyerProSlice;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  exportPrefs: FlyerProSlice;

  @Column({ type: 'jsonb', nullable: true })
  layoutSnapshot: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  layoutDigest: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  renderDigest: string | null;

  @Column({ type: 'integer', default: 1 })
  schemaVersion: number;

  @Column({ type: 'integer' })
  engineVersion: number;

  @Column({ type: 'integer', default: 0 })
  revision: number;

  @Column({ type: 'uuid', nullable: true })
  lastMutationId: string | null;

  @Column({ type: 'uuid', nullable: true })
  creationKey: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt: Date | null;
}
