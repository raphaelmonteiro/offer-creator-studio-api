import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ClientContact } from './client-contact.entity';
import { ClientStore } from './client-store.entity';

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
   * LEGADO — rodapé "ativo" do cliente (uma `TemplateSection` opaca). Mantido para
   * retrocompatibilidade: espelha o primeiro item de `footers`. Consumidores antigos que leem
   * `client.footer` continuam funcionando. Novos fluxos usam a biblioteca `footers`.
   */
  @Column({ type: 'jsonb', nullable: true })
  footer: Record<string, unknown> | null;

  /**
   * Biblioteca de rodapés do cliente — vários rodapés nomeados reutilizáveis (ex.: uma loja/
   * endereço por rodapé). Cada item: `{ id, name, section: TemplateSection }`. Opaca, validada
   * no frontend (mesmo espírito de flyer.configuration / user.establishment).
   */
  @Column({ type: 'jsonb', nullable: true })
  footers: Record<string, unknown>[] | null;

  @OneToMany(() => ClientContact, (contact) => contact.client, {
    cascade: true,
    eager: true,
  })
  contacts: ClientContact[];

  /** Lojas/unidades da rede — cada uma com endereço/CNPJ/telefone/horário próprios. */
  @OneToMany(() => ClientStore, (store) => store.client, {
    cascade: true,
    eager: true,
  })
  stores: ClientStore[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
