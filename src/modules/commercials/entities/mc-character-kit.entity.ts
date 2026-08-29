import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { McKitStatus } from '../domain/mc-state-machines';

/**
 * O enum mudou-se para domain/mc-state-machines (casa das máquinas formais,
 * junto com MC_KIT_TRANSITIONS); o reexport preserva os imports existentes.
 */
export { McKitStatus };

/**
 * Kit do mascote — Ativo de Personagem, 1× por mascote (plano-comerciais §4):
 * descrição canônica + voz + assets de referência. IMUTÁVEL após approved
 * (mudança de identidade = nova versão), para que projetos antigos continuem
 * reproduzíveis.
 *
 * `mascotId` é referência LÓGICA (sem FK física para `mascots`): o boundary
 * entre módulos vale também no schema — commercials não acopla seu ciclo de
 * vida ao de mascots (mesma razão do lint de boundary do .eslintrc.js).
 */
@Entity('mc_character_kits')
@Index(['userId', 'status'])
export class McCharacterKit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  /** Referência lógica a mascots.id — reusa direitos/identidade, sem FK física. */
  @Column({ type: 'uuid' })
  mascotId: string;

  @Column({ type: 'varchar', length: 20, default: McKitStatus.GENERATING })
  status: McKitStatus;

  /** Descrição canônica do personagem (vai em todo prompt de cena, §4). */
  @Column({ type: 'text', nullable: true })
  canonicalDesc: string | null;

  /** Voz fixa do mascote no provider de TTS (a voz é o ativo, §5.3). */
  @Column({ type: 'text', nullable: true })
  voiceId: string | null;

  /** Assets de referência (kind `kit_reference` na animation_assets, §6.1). */
  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  referenceAssetIds: string[];

  @Column({ type: 'uuid', nullable: true })
  cutoutAssetId: string | null;

  /** Imutável após approved: mudou o mascote → nova versão (plano §6.3). */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** Resultado auditado da moderação (omni-moderation, plano §6.8). */
  @Column({ type: 'jsonb', nullable: true })
  moderation: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;
}
