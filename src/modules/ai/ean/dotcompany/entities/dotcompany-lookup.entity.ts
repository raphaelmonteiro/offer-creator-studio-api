import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { DotcompanyLookupItem, LookupStatus } from '../dotcompany.types';

/** Cache por EAN da resposta da DotCompany: cada EAN é pago no máximo uma vez. */
@Entity('dotcompany_lookups')
export class DotcompanyLookup {
  @PrimaryColumn({ type: 'varchar', length: 14 })
  ean: string;

  @Column({ type: 'varchar', length: 16 })
  status: LookupStatus;

  @Column({ type: 'jsonb', nullable: true })
  raw: DotcompanyLookupItem | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  etag: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  fetchedAt: Date;

  /** Não encontrado: antes disso, nem consulta de novo. */
  @Column({ type: 'timestamptz', nullable: true })
  retryAfter: Date | null;

  /** A foto DotCompany importada para a galeria, se houver. */
  @Column({ type: 'uuid', nullable: true })
  galleryImageId: string | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
