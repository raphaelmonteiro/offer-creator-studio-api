import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GalleryFolder } from './gallery-folder.entity';

@Entity('gallery_images', { synchronize: false })
export class GalleryImage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column()
  url: string;

  @Column({ nullable: true })
  thumbnailUrl: string | null;

  @Column()
  mimeType: string;

  @Column('bigint')
  size: number;

  @Column({ type: 'uuid', nullable: true })
  folderId: string | null;

  @ManyToOne(() => GalleryFolder, (folder) => folder.images, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'folderId' })
  folder: GalleryFolder | null;

  @Column({ name: 'metadata_status', type: 'varchar', length: 16, nullable: true })
  metadataStatus: 'pending' | 'ready' | 'failed' | null;

  @Column({ name: 'metadata_error', type: 'text', nullable: true })
  metadataError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
