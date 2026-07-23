import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Client } from './client.entity';

/**
 * Loja/unidade de um cliente (rede/estabelecimento). Uma rede pode ter várias lojas, cada uma com
 * endereço, CNPJ, telefones, e-mail e horário próprios — usados para gerar o rodapé daquela loja.
 */
@Entity('client_stores')
export class ClientStore {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Apelido da loja (ex.: "Loja Centro"). */
  @Column()
  name: string;

  @Column({ nullable: true })
  cnpj: string | null;

  @Column({ nullable: true })
  address: string | null;

  @Column({ nullable: true })
  phoneFixed: string | null;

  @Column({ nullable: true })
  phoneMobile: string | null;

  @Column({ nullable: true })
  email: string | null;

  /** Horário de funcionamento (texto livre, ex.: "Seg a Sáb 8h–20h · Dom 8h–13h"). */
  @Column({ nullable: true })
  hours: string | null;

  @Column()
  clientId: string;

  @ManyToOne(() => Client, (client) => client.stores, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clientId' })
  client: Client;
}
