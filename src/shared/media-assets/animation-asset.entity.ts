import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

export type AnimationAssetKind =
  | 'background_video'
  | 'mascot_video'
  | 'talking_mascot'
  | 'audio'
  | 'image'
  | 'imported_video'
  | 'export'
  /** Imagem de referência do kit do mascote (plano-comerciais §6.1, kinds novos). */
  | 'kit_reference'
  /** Keyframe de cena do comercial (plano-comerciais §6.1). */
  | 'keyframe'
  /** Clipe cru de cena (sem fala) do comercial (plano-comerciais §6.1). */
  | 'scene_clip'
  /** Clipe de cena falada já sincronizado (audio-driven, plano-comerciais §6.1). */
  | 'scene_synced'
  /** Vídeo final montado do comercial (plano-comerciais §6.1). */
  | 'commercial_final';

export type AnimationAssetStatus =
  | 'draft'
  | 'processing'
  | 'ready'
  | 'approved'
  | 'failed'
  | 'archived';

@Entity('animation_assets')
@Index(['userId', 'kind', 'status'])
export class AnimationAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ type: 'varchar', length: 30 })
  kind: AnimationAssetKind;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: AnimationAssetStatus;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 20 })
  origin: 'ai_generated' | 'imported' | 'export' | 'frozen_frame';

  @Column({ nullable: true })
  sourceTaskId: string | null;

  @Column({ nullable: true })
  fileUrl: string | null;

  /** Mezanino VP9 yuva420p com alpha real (mascotes — TDD §5.2). */
  @Column({ nullable: true })
  alphaUrl: string | null;

  @Column({ nullable: true })
  posterUrl: string | null;

  @Column({ nullable: true })
  thumbUrl: string | null;

  @Column({ nullable: true })
  mimeType: string | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ type: 'bigint', nullable: true })
  fileSize: string | null;

  @Column({ default: false })
  hasAlpha: boolean;

  /** Dedupe de TTS (TDD §5.3): sha256(texto+voiceId+settings), escopado por usuário. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index()
  contentHash: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date | null;
}
