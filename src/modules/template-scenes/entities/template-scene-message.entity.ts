import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SceneMessageRole, SceneMessageStatus } from '../domain/scene.types';
import { TemplateScene } from './template-scene.entity';

/** Mensagem do chat da cena. `versionId` liga a mensagem à versão que ela gerou (sem FK). */
@Entity('template_scene_messages')
@Index('IDX_tsm_scene_created', ['sceneId', 'createdAt'])
export class TemplateSceneMessage {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_template_scene_messages' })
  id: string;

  @Column({ type: 'uuid' })
  sceneId: string;

  @ManyToOne(() => TemplateScene, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'sceneId', foreignKeyConstraintName: 'FK_tsm_scene' })
  scene?: TemplateScene;

  @Column({ type: 'uuid', nullable: true })
  versionId: string | null;

  @Column({ type: 'varchar', length: 10 })
  role: SceneMessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  attachments: Array<{ assetId: string; name?: string }>;

  @Column({ type: 'varchar', length: 10, default: 'done' })
  status: SceneMessageStatus;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
