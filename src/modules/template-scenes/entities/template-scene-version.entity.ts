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
import {
  MaskShape,
  Rect,
  SceneElement,
  SceneFailureCode,
  SceneStep,
  SceneVersionMetrics,
  SceneVersionOperation,
  SceneVersionStatus,
} from '../domain/scene.types';
import { numericTransformer } from './numeric.transformer';
import { TemplateScene } from './template-scene.entity';

/**
 * Versão da cena. Só uma versão `queued` ou `running` por cena (índice parcial `UQ_tsv_scene_busy`,
 * a garantia de D-3 no banco). Versões `manual`, `set_layer` e `restore` apontam para a master e a
 * prévia da versão de origem, sem copiar o arquivo. `updatedAt` marca a última atividade (o
 * reconciliador de versões presas usa esse campo).
 */
@Entity('template_scene_versions')
@Index('UQ_tsv_scene_number', ['sceneId', 'number'], { unique: true })
@Index('IDX_tsv_scene_status', ['sceneId', 'status'])
@Index('IDX_tsv_scene_face_status', ['sceneId', 'faceIndex', 'status'])
@Index('UQ_tsv_scene_busy', ['sceneId'], {
  unique: true,
  where: `"status" IN ('queued', 'running')`,
})
export class TemplateSceneVersion {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_template_scene_versions' })
  id: string;

  @Column({ type: 'uuid' })
  sceneId: string;

  @ManyToOne(() => TemplateScene, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'sceneId', foreignKeyConstraintName: 'FK_tsv_scene' })
  scene?: TemplateScene;

  @Column({ type: 'uuid', nullable: true })
  parentVersionId: string | null;

  /** Face da versão (`template_scene_faces.index`); 0 na cena de uma face e na frente (PV-1). */
  @Column({ type: 'smallint', default: 0 })
  faceIndex: number;

  /** Verso derivado: a versão da frente cuja master serviu de referência (só auditoria; não protege a master). */
  @Column({ type: 'uuid', nullable: true })
  derivedFromVersionId: string | null;

  @Column({ type: 'int' })
  number: number;

  @Column({ type: 'varchar', length: 20 })
  operation: SceneVersionOperation;

  @Column({ type: 'varchar', length: 12 })
  status: SceneVersionStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  step: SceneStep | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelRequestedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  requestedRegion: Rect | null;

  @Column({ type: 'jsonb', nullable: true })
  requestedMask: MaskShape | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  targetElementId: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  elements: SceneElement[];

  @Column({ type: 'jsonb', default: () => `'{}'` })
  metrics: SceneVersionMetrics;

  @Column({ type: 'uuid', nullable: true })
  masterAssetId: string | null;

  @Column({ type: 'uuid', nullable: true })
  previewAssetId: string | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    default: 0,
    transformer: numericTransformer,
  })
  providerCostUsd: number;

  @Column({ type: 'int', nullable: true })
  latencyMs: number | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  errorCode: SceneFailureCode | null;

  @Column({ type: 'uuid' })
  correlationId: string;

  @Column({ type: 'boolean', default: false })
  isOpenManual: boolean;

  /** Estágio 5. */
  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
