import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Client } from '../../clients/entities/client.entity';

@Entity('flyers')
export class Flyer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  clientId: string | null;

  @ManyToOne(() => Client, { nullable: true })
  @JoinColumn({ name: 'clientId' })
  client: Client | null;

  @Column({ nullable: true })
  thumbnailUrl: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status: string;

  /**
   * Tipo de documento. Discrimina entre encarte impresso e arte para redes sociais.
   * - `'flyer'` (default): encarte tradicional, listado em /flyers
   * - `'social'`: arte social, listada em /social
   *
   * Adicionado para suportar o fluxo de criação de Social Media (V2).
   * Default mantém compatibilidade com documentos existentes.
   */
  @Column({ type: 'varchar', length: 20, default: 'flyer' })
  kind: string;

  @Column('jsonb')
  configuration: any;

  @Column({ type: 'varchar', length: 20, default: 'auto' })
  layout: string;

  @Column('jsonb', { nullable: true })
  customGridConfig: any | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
