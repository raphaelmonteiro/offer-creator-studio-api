import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { McSceneStatus } from '../domain/mc-state-machines';
import { McSceneType } from '../domain/mc-types';
import { McProject } from './mc-project.entity';

/**
 * Cena — a unidade de re-roll (plano-comerciais §6.1): `generation` bumpa a
 * cada re-roll e os steps da geração antiga ficam para trás (o scheduler os
 * ignora). Os *AssetId são atalhos para os assets CORRENTES da cena; a trilha
 * completa fica nos mc_steps.
 */
@Entity('mc_scenes')
@Unique(['projectId', 'idx'])
@Index(['projectId', 'scriptSceneId'])
export class McScene {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectId: string;

  @ManyToOne(() => McProject, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: McProject;

  /** Posição da cena no comercial (0-based, ordem de montagem). */
  @Column({ type: 'int' })
  idx: number;

  /**
   * Identidade editorial da cena no roteiro v2 (`script.scenes[].sceneId`) —
   * estável entre reordenações/revisões; `idx` é só a ordem. NULL no legado.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  scriptSceneId: string | null;

  /** NULL preserva o executor por diálogo dos registros legados. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  sceneType: McSceneType | null;

  /** Geração corrente — re-roll incrementa (plano §6.3). */
  @Column({ type: 'int', default: 1 })
  generation: number;

  /**
   * Nº de re-rolls pedidos pelo usuário (plano §8: o 1º é grátis — embutido no
   * preço da cena; do 2º em diante há mini-reserva de custoDaCena). Edição de
   * fala NÃO conta (é edição, não re-roll). Coluna criada pela migration
   * AddSceneRerollCount (1766900000000).
   */
  @Column({ type: 'int', default: 0 })
  rerollCount: number;

  @Column({ type: 'varchar', length: 20, default: McSceneStatus.PENDING })
  status: McSceneStatus;

  @Column({ type: 'int' })
  durationS: number;

  @Column({ type: 'text' })
  actionPrompt: string;

  /** null = cena muda (sem tts/lipsync — finaliza no video). */
  @Column({ type: 'text', nullable: true })
  dialogue: string | null;

  @Column({ type: 'uuid', nullable: true })
  keyframeAssetId: string | null;

  @Column({ type: 'uuid', nullable: true })
  videoAssetId: string | null;

  @Column({ type: 'uuid', nullable: true })
  audioAssetId: string | null;

  /** Final da cena: clip sincronizado (falada) ou o próprio video (muda). */
  @Column({ type: 'uuid', nullable: true })
  finalAssetId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
