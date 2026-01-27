import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { GalleryImage } from './entities/gallery-image.entity';
import { GalleryFolder } from './entities/gallery-folder.entity';
import { QueryGalleryDto } from './dto/query-gallery.dto';
import { UploadsService } from '../uploads/uploads.service';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';
import { DeleteManyDto } from './dto/delete-many.dto';
import { MoveImagesDto } from './dto/move-images.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';

@Injectable()
export class GalleryService {
  constructor(
    @InjectRepository(GalleryImage)
    private readonly imagesRepository: Repository<GalleryImage>,
    @InjectRepository(GalleryFolder)
    private readonly foldersRepository: Repository<GalleryFolder>,
    private readonly uploadsService: UploadsService,
  ) {}

  async listImages(
    query: QueryGalleryDto,
  ): Promise<PaginationResult<GalleryImage>> {
    const { page = 1, limit = 20, search, folderId } = query;
    const skip = (page - 1) * limit;

    const qb = this.imagesRepository.createQueryBuilder('image');

    if (search) {
      qb.where('image.filename LIKE :search', { search: `%${search}%` });
    }

    if (folderId === 'none') {
      qb.andWhere('image.folderId IS NULL');
    } else if (folderId) {
      qb.andWhere('image.folderId = :folderId', { folderId });
    }

    qb.orderBy('image.createdAt', 'DESC').skip(skip).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return paginate(items, total, { page, limit });
  }

  async uploadImages(
    files: Express.Multer.File[],
    folderId?: string | null,
  ): Promise<GalleryImage[]> {
    const images: GalleryImage[] = [];

    for (const file of files) {
      const uploaded = await this.uploadsService.uploadFile(file, 'gallery');

      const image = this.imagesRepository.create({
        filename: uploaded.filename,
        url: uploaded.url,
        thumbnailUrl: uploaded.url, // por enquanto usar mesma URL
        mimeType: uploaded.mimeType,
        size: uploaded.size,
        folderId: folderId || null,
      });

      images.push(await this.imagesRepository.save(image));
    }

    return images;
  }

  async deleteImage(id: string): Promise<void> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image) {
      throw new NotFoundException({
        code: 'GALLERY_IMAGE_NOT_FOUND',
        message: 'Imagem não encontrada',
      });
    }

    await this.imagesRepository.remove(image);
  }

  async deleteMany(dto: DeleteManyDto): Promise<{ success: boolean; deleted: number }> {
    const result = await this.imagesRepository.delete(dto.ids);
    return {
      success: true,
      deleted: result.affected || 0,
    };
  }

  async moveImages(
    dto: MoveImagesDto,
  ): Promise<{ success: boolean; moved: number }> {
    const { imageIds, folderId } = dto;
    await this.imagesRepository
      .createQueryBuilder()
      .update(GalleryImage)
      .set({ folderId: folderId || null })
      .where('id IN (:...ids)', { ids: imageIds })
      .execute();

    return {
      success: true,
      moved: imageIds.length,
    };
  }

  async listFolders(): Promise<
    Array<GalleryFolder & { imageCount: number }>
  > {
    const folders = await this.foldersRepository.find();

    const counts = await this.imagesRepository
      .createQueryBuilder('image')
      .select('image.folderId', 'folderId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('image.folderId')
      .getRawMany<{ folderId: string | null; count: string }>();

    const map = new Map<string, number>();
    counts.forEach((row) => {
      if (row.folderId) {
        map.set(row.folderId, parseInt(row.count, 10));
      }
    });

    return folders.map((folder) => ({
      ...folder,
      imageCount: map.get(folder.id) || 0,
    }));
  }

  async createFolder(dto: CreateFolderDto): Promise<GalleryFolder & { imageCount: number }> {
    const folder = this.foldersRepository.create({
      name: dto.name,
      color: dto.color || null,
    });
    const saved = await this.foldersRepository.save(folder);
    return { ...saved, imageCount: 0 };
  }

  async updateFolder(
    id: string,
    dto: UpdateFolderDto,
  ): Promise<GalleryFolder & { imageCount: number }> {
    const folder = await this.foldersRepository.findOne({ where: { id } });
    if (!folder) {
      throw new NotFoundException({
        code: 'GALLERY_FOLDER_NOT_FOUND',
        message: 'Pasta não encontrada',
      });
    }

    Object.assign(folder, {
      name: dto.name ?? folder.name,
      color: dto.color ?? folder.color,
    });

    const saved = await this.foldersRepository.save(folder);

    const imageCount = await this.imagesRepository.count({
      where: { folderId: saved.id },
    });

    return { ...saved, imageCount };
  }

  async deleteFolder(id: string): Promise<{ success: boolean }> {
    const folder = await this.foldersRepository.findOne({ where: { id } });
    if (!folder) {
      throw new NotFoundException({
        code: 'GALLERY_FOLDER_NOT_FOUND',
        message: 'Pasta não encontrada',
      });
    }

    // Mover imagens para raiz (folderId = null)
    await this.imagesRepository
      .createQueryBuilder()
      .update(GalleryImage)
      .set({ folderId: null })
      .where('folderId = :id', { id })
      .execute();

    await this.foldersRepository.remove(folder);

    return { success: true };
  }
}

