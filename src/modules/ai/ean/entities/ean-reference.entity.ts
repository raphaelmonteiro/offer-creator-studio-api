import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { ReferenceSource } from '../ean-match.types';

/** Cache por EAN da descrição/foto oficial, reaproveitado entre jobs. */
@Entity('ean_references')
export class EanReference {
  @PrimaryColumn({ type: 'varchar', length: 14 })
  ean: string;

  @Column({ type: 'varchar', length: 16 })
  source: ReferenceSource;

  @Column({ type: 'text', nullable: true })
  name: string | null;

  @Column({ type: 'text', nullable: true })
  brand: string | null;

  @Column({ type: 'text', nullable: true })
  quantity: string | null;

  @Column({ type: 'text', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'jsonb', nullable: true })
  raw: unknown;

  @UpdateDateColumn({ type: 'timestamptz' })
  fetchedAt: Date;
}
