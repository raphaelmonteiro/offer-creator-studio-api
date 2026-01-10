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
