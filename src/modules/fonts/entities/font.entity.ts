import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('fonts')
export class Font {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  family: string;

  @Column()
  weight: string;

  @Column()
  style: string;

  @Column()
  fileUrl: string;

  @CreateDateColumn()
  createdAt: Date;
}
