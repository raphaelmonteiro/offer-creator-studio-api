import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import * as bcrypt from 'bcrypt';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  @Column()
  name: string;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ type: 'varchar', length: 20, default: 'user' })
  role: string;

  @Column({ nullable: true })
  phone: string | null;

  @Column({ nullable: true })
  cpfCnpj: string | null;

  @Column('jsonb', { nullable: true })
  establishment: {
    tradeName?: string;
    companyName?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  } | null;

  @Column({ nullable: true })
  avatarUrl: string | null;

  @Column({ nullable: true })
  emailVerificationToken: string | null;

  @Column({ nullable: true })
  emailVerificationExpires: Date | null;

  @Column({ nullable: true })
  passwordResetToken: string | null;

  @Column({ nullable: true })
  passwordResetExpires: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @BeforeInsert()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$2b$')) {
      // Só hasheia se ainda não estiver hasheada
      this.password = await bcrypt.hash(this.password, 10);
    }
  }

  @BeforeUpdate()
  async hashPasswordIfChanged() {
    if (this.password && !this.password.startsWith('$2b$')) {
      // Só hasheia se ainda não estiver hasheada
      this.password = await bcrypt.hash(this.password, 10);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }
}
