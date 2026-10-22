import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { McPieceAspectRatio, McPieceDocument } from '../domain/mc-piece';

export const MC_PIECE_KINDS = ['piece', 'template'] as const;
export type McPieceKind = (typeof MC_PIECE_KINDS)[number];

/**
 * Peça de ofertas configurável (change video-peca-configuravel): o que o
 * cliente monta no editor antes de existir projeto — fundo, produtos, logo,
 * textos, rodapé e personagem, em frações do quadro (`domain/mc-piece`). Com
 * `kind = 'template'` é um modelo da conta (sem produtos, sem cliente).
 *
 * `clientId` é referência LÓGICA a `clients.id` (sem FK física: boundary
 * entre módulos, como `mascotId` no kit). `revision` é o lock otimista do
 * autosave (`expectedRevision` → 409 REVISION_CONFLICT).
 */
@Entity('mc_pieces')
@Index(['userId', 'kind', 'updatedAt'])
export class McPiece {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  clientId: string | null;

  @Column({ type: 'varchar', length: 10, default: 'piece' })
  kind: McPieceKind;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** Espelho de `document.aspectRatio` para listar/filtrar sem abrir o jsonb. */
  @Column({ type: 'varchar', length: 10, default: '9:16' })
  aspectRatio: McPieceAspectRatio;

  @Column({ type: 'jsonb' })
  document: McPieceDocument;

  @Column({ type: 'int', default: 0 })
  revision: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
