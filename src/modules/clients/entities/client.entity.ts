import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ClientContact } from './client-contact.entity';

@Entity('clients')
export class Client {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  cnpj: string;

  @Column({ nullable: true })
  logoUrl: string | null;

  // Dados de contato do estabelecimento (eram coletados no form mas nunca persistiam).
  @Column({ nullable: true })
  email: string | null;

  @Column({ nullable: true })
  address: string | null;

  @Column({ nullable: true })
  phoneFixed: string | null;

  @Column({ nullable: true })
  phoneMobile: string | null;

  /**
   * Modelo de rodapé do cliente (uma `TemplateSection` opaca, no mesmo espírito de
   * flyer.configuration / user.establishment). Reaplicável a encartes/templates/social.
   */
  @Column({ type: 'jsonb', nullable: true })
  footer: Record<string, unknown> | null;

  @OneToMany(() => ClientContact, (contact) => contact.client, {
    cascade: true,
    eager: true,
  })
  contacts: ClientContact[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
