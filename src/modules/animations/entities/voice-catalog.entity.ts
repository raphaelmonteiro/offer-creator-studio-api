import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/** Catálogo curado de vozes ElevenLabs (TDD §5.3) — seed/admin, nunca a lista bruta do provider. */
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

  @Column({ type: 'int', default: 0 })
  sort: number;

  @CreateDateColumn()
  createdAt: Date;
}
