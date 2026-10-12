import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Catálogo curado de vozes ElevenLabs (TDD §5.3) — seed/admin, nunca a lista
 * bruta do provider. Extraído de modules/animations/entities para src/shared/
 * (plano-comerciais §11): a tabela é compartilhada — animations lista vozes
 * para dublagem e commercials usa a MESMA tabela para a voz permanente do kit
 * do mascote (§4) — e nenhum dos dois pode importar do outro (lint de
 * boundary no .eslintrc.js).
 */
@Entity('voice_catalog')
export class VoiceCatalogEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  providerVoiceId: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 10, default: 'pt-BR' })
  language: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  gender: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  style: string | null;

  /** Trecho de preview pré-gerado servido de /uploads — ouvir antes de gastar crédito. */
  @Column({ nullable: true })
  previewUrl: string | null;

  @Column({ default: true })
  enabled: boolean;

  /**
   * Curada pela equipe (CURATED_VOICES do sync ou promoção manual do admin):
   * visível para TODOS os usuários. Não curada e sem dono (Voice Library,
   * clones antigos da conta) fica oculta para todos (D10).
   */
  @Column({ default: false })
  curated: boolean;

  /** Dono de uma voz clonada para um usuário — só ele a vê e a usa num kit. */
  @Index('IDX_voice_catalog_owner_user')
  @Column({ type: 'uuid', nullable: true })
  ownerUserId: string | null;

  @Column({ type: 'int', default: 0 })
  sort: number;

  @CreateDateColumn()
  createdAt: Date;
}
