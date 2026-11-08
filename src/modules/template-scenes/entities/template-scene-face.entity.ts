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
import { FaceKey } from '../domain/scene-faces';
import { SceneZones } from '../domain/scene.types';
import { TemplateScene } from './template-scene.entity';

/**
 * Face da cena (D-1): uma face (`single`) ou frente e verso. Guarda as zonas (calculadas na criação por `faceZones`),
 * a versão atual e o template da face. `currentVersionId` e `templateId` não têm FK (como na cena); a face 0 é
 * espelhada em `template_scenes.currentVersionId` e `approvedTemplateId`. As faces nunca são apagadas nem reordenadas
 * (PV-1); só a exclusão da cena as leva, em cascata.
 */
@Entity('template_scene_faces')
@Index('UQ_tsf_scene_index', ['sceneId', 'index'], { unique: true })
@Index('UQ_tsf_scene_key', ['sceneId', 'key'], { unique: true })
export class TemplateSceneFace {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_template_scene_faces' })
  id: string;

  @Column({ type: 'uuid' })
  sceneId: string;

  @ManyToOne(() => TemplateScene, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'sceneId', foreignKeyConstraintName: 'FK_tsf_scene' })
  scene?: TemplateScene;

  @Column({ type: 'smallint' })
  index: number;

  @Column({ type: 'varchar', length: 16 })
  key: FaceKey;

  /** `Frente` ou `Verso`; nulo na face única. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  label: string | null;

  @Column({ type: 'jsonb' })
  zones: SceneZones;

  @Column({ type: 'int' })
  widthPx: number;

  @Column({ type: 'int' })
  heightPx: number;

  @Column({ type: 'uuid', nullable: true })
  currentVersionId: string | null;

  @Column({ type: 'uuid', nullable: true })
  templateId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
