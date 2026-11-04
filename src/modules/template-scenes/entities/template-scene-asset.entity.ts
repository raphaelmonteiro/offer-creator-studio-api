import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SceneAssetRole } from '../domain/scene.types';
import { TemplateSceneVersion } from './template-scene-version.entity';

/**
 * Arquivo da cena em `uploads/template-scenes/<sceneId>/<versionId>/`. `versionId` é a versão que
 * CRIOU o asset; versões `manual`/`restore` apontam para ele sem copiar. `expiresAt` marca o que o
 * GC pode apagar; `purgedAt` grava, antes de apagar o arquivo, que ele deixou de existir (o
 * `restore` confere esse campo sob o lock da cena).
 */
@Entity('template_scene_assets')
@Index('IDX_tsa_expires', ['expiresAt'])
@Index('IDX_tsa_scene', ['sceneId'])
export class TemplateSceneAsset {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_template_scene_assets' })
  id: string;

  @Column({ type: 'uuid' })
  versionId: string;

  @ManyToOne(() => TemplateSceneVersion, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'versionId', foreignKeyConstraintName: 'FK_tsa_version' })
  version?: TemplateSceneVersion;

  @Column({ type: 'uuid' })
  sceneId: string;

  @Column({ type: 'varchar', length: 16 })
  role: SceneAssetRole;

  /** Relativa: `/uploads/template-scenes/<sceneId>/<versionId>/<arquivo>`. */
  @Column({ type: 'varchar', length: 500 })
  url: string;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'int', default: 0 })
  bytes: number;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  purgedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
