import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('templates')
export class Template {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: string; // header, footer, full

  @Column({ nullable: true })
  thumbnailUrl: string | null;

  @Column({ default: false })
  isDefault: boolean;

  @Column('jsonb')
  configuration: any;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
