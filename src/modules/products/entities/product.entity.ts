import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  originalPrice: number | null;

  @Column()
  unit: string;

  @Column({ nullable: true })
  imageUrl: string | null;

  @Column({ nullable: true })
  category: string | null;

  @Column({ unique: true, nullable: true })
  sku: string | null;

  @Column({ type: 'text', nullable: true })
  observation: string | null;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
