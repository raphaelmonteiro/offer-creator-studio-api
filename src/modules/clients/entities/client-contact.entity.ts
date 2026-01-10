import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Client } from './client.entity';

@Entity('client_contacts')
export class ClientContact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  role: string;

  @Column()
  email: string;

  @Column()
  phone: string;

  @Column()
  clientId: string;

  @ManyToOne(() => Client, (client) => client.contacts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clientId' })
  client: Client;
}
