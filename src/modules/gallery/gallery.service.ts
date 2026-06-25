import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import { GalleryImage } from './entities/gallery-image.entity';
import { GalleryFolder } from './entities/gallery-folder.entity';
import { QueryGalleryDto } from './dto/query-gallery.dto';
import { UploadsService } from '../uploads/uploads.service';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';
import { DeleteManyDto } from './dto/delete-many.dto';
import { MoveImagesDto } from './dto/move-images.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { UpdateImageDto } from './dto/update-image.dto';

interface EmbeddingTrigger {
  embedAndStoreForImage: (
    imageId: string,
    filename: string,
    folderName?: string | null,
  ) => Promise<boolean>;
  setMetadataStatus?: (imageId: string, status: 'pending' | 'ready' | 'failed') => Promise<void>;
  saveImageMetadata?: (imageId: string, metadata: unknown) => Promise<void>;
  embedAndStoreMetadataForImage?: (imageId: string, metadata: unknown) => Promise<boolean>;
}

interface MetadataExtractor {
  isEnabled: () => boolean;
  extractFromImage: (url: string) => Promise<unknown>;
}

@Injectable()
export class GalleryService implements OnModuleInit {
  private readonly logger = new Logger(GalleryService.name);
  private readonly fuzzySearchThreshold = 0.25;

  constructor(
    @InjectRepository(GalleryImage)
    private readonly imagesRepository: Repository<GalleryImage>,
    @InjectRepository(GalleryFolder)
    private readonly foldersRepository: Repository<GalleryFolder>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly uploadsService: UploadsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS unaccent');
      await this.dataSource.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    } catch (error) {
      this.logger.warn(`Falha ao preparar busca tolerante da galeria: ${(error as Error).message}`);
    }

    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS gallery_folders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name varchar NOT NULL,
          color varchar,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
        )
      `);
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS gallery_images (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          filename varchar NOT NULL,
          url varchar NOT NULL,
          "thumbnailUrl" varchar,
          "mimeType" varchar NOT NULL,
          size bigint NOT NULL,
          "folderId" uuid REFERENCES gallery_folders(id) ON DELETE SET NULL,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
        )
      `);
    } catch (error) {
      this.logger.error(`Falha ao garantir schema da galeria: ${(error as Error).message}`);
    }
  }

  private triggerEmbedding(image: GalleryImage): void {
    void (async () => {
      try {
        const embedder = this.moduleRef.get<EmbeddingTrigger>('GalleryEmbeddingService', {
          strict: false,
        });
        if (!embedder) return;
        let folderName: string | null = null;
        if (image.folderId) {
          const folder = await this.foldersRepository.findOne({
            where: { id: image.folderId },
            select: ['name'],
          });
          folderName = folder?.name ?? null;
        }
        await embedder.embedAndStoreForImage(image.id, image.filename, folderName);
      } catch (error) {
        this.logger.warn(
          `Falha ao gerar embedding para imagem ${image.id}: ${(error as Error).message}`,
        );
      }
    })();
  }

  private triggerMetadata(image: GalleryImage): void {
    void (async () => {
      let embedder: EmbeddingTrigger | null = null;
      try {
        embedder = this.moduleRef.get<EmbeddingTrigger>('GalleryEmbeddingService', {
          strict: false,
        });
      } catch {
        embedder = null;
      }

      let extractor: MetadataExtractor | null = null;
      try {
        extractor = this.moduleRef.get<MetadataExtractor>('ImageMetadataService', {
          strict: false,
        });
      } catch {
        extractor = null;
      }

      if (!extractor || !extractor.isEnabled()) {
        return;
      }

      try {
        await embedder?.setMetadataStatus?.(image.id, 'pending');
        const metadata = await extractor.extractFromImage(image.url);
        if (!metadata) {
          await embedder?.setMetadataStatus?.(image.id, 'failed');
          return;
        }
        await embedder?.saveImageMetadata?.(image.id, metadata);
        await embedder?.embedAndStoreMetadataForImage?.(image.id, metadata);
      } catch (error) {
        this.logger.warn(
          `Falha ao extrair metadata da imagem ${image.id}: ${(error as Error).message}`,
        );
        try {
          await embedder?.setMetadataStatus?.(image.id, 'failed');
        } catch {
          /* swallow */
        }
      }
    })();
  }

  private getFilenameExtension(filename: string): string {
    const match = filename.match(/(\.[a-z0-9]+)$/i);
    return match ? match[1] : '';
  }

  private buildFilenameWithPreservedExtension(
    currentFilename: string,
    nextFilename: string,
  ): string {
    const extension = this.getFilenameExtension(currentFilename);
    const trimmed = nextFilename.trim();

    if (!trimmed) {
      throw new BadRequestException({
        code: 'INVALID_GALLERY_IMAGE_FILENAME',
        message: 'Nome da imagem é obrigatório',
      });
    }

    const inputExtension = this.getFilenameExtension(trimmed);
    if (inputExtension && inputExtension.toLowerCase() !== extension.toLowerCase()) {
      throw new BadRequestException({
        code: 'GALLERY_IMAGE_EXTENSION_CHANGE_NOT_ALLOWED',
        message: 'A extensão da imagem não pode ser alterada',
      });
    }

    const baseName = (inputExtension ? trimmed.slice(0, -inputExtension.length) : trimmed)
      .trim()
      .replace(/[\\/]/g, '-');

    if (!baseName) {
      throw new BadRequestException({
        code: 'INVALID_GALLERY_IMAGE_FILENAME',
        message: 'Nome da imagem é obrigatório',
      });
    }

    return `${baseName}${extension}`;
  }

  async listImages(query: QueryGalleryDto): Promise<PaginationResult<GalleryImage>> {
    const { page = 1, limit = 20, search, folderId } = query;
    const skip = (page - 1) * limit;

    const qb = this.imagesRepository.createQueryBuilder('image');

    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const searchableFilename = 'unaccent(lower(image.filename))';
      const searchableQuery = 'unaccent(lower(:search))';
      qb.andWhere(
        new Brackets((where) => {
          where
            .where(`${searchableFilename} LIKE '%' || ${searchableQuery} || '%'`)
            .orWhere(
              `similarity(${searchableFilename}, ${searchableQuery}) >= :fuzzySearchThreshold`,
            );
        }),
      )
        .addSelect(
          `CASE
            WHEN ${searchableFilename} LIKE '%' || ${searchableQuery} || '%' THEN 0
            ELSE 1
          END`,
          'gallery_search_rank',
        )
        .addSelect(
          `similarity(${searchableFilename}, ${searchableQuery})`,
          'gallery_search_similarity',
        )
        .setParameter('search', normalizedSearch)
        .setParameter('fuzzySearchThreshold', this.fuzzySearchThreshold);
    }

    if (folderId === 'none') {
      qb.andWhere('image.folderId IS NULL');
    } else if (folderId) {
      qb.andWhere('image.folderId = :folderId', { folderId });
    }

    if (normalizedSearch) {
      qb.orderBy('gallery_search_rank', 'ASC')
        .addOrderBy('gallery_search_similarity', 'DESC')
        .addOrderBy('image.createdAt', 'DESC');
    } else {
      qb.orderBy('image.createdAt', 'DESC');
    }

    qb.skip(skip).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return paginate(items, total, { page, limit });
  }

  async registerImage(params: {
    filename: string;
    url: string;
    mimeType: string;
    size: number;
  }): Promise<GalleryImage> {
    const image = this.imagesRepository.create({
      filename: params.filename,
      url: params.url,
      thumbnailUrl: params.url,
      mimeType: params.mimeType,
      size: params.size,
      folderId: null,
    });
    const saved = await this.imagesRepository.save(image);
    this.triggerEmbedding(saved);
    this.triggerMetadata(saved);
    return saved;
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

      const saved = await this.imagesRepository.save(image);
      this.triggerEmbedding(saved);
      this.triggerMetadata(saved);
      images.push(saved);
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

  async updateImage(id: string, dto: UpdateImageDto): Promise<GalleryImage> {
    const image = await this.imagesRepository.findOne({ where: { id } });
    if (!image) {
      throw new NotFoundException({
        code: 'GALLERY_IMAGE_NOT_FOUND',
        message: 'Imagem não encontrada',
      });
    }

    const nextFilename = this.buildFilenameWithPreservedExtension(image.filename, dto.filename);

    image.filename = nextFilename;
    const saved = await this.imagesRepository.save(image);
    this.triggerEmbedding(saved);
    this.triggerMetadata(saved);

    return saved;
  }

  async deleteMany(dto: DeleteManyDto): Promise<{ success: boolean; deleted: number }> {
    const result = await this.imagesRepository.delete(dto.ids);
    return {
      success: true,
      deleted: result.affected || 0,
    };
  }

  async moveImages(dto: MoveImagesDto): Promise<{ success: boolean; moved: number }> {
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

  async listFolders(): Promise<Array<GalleryFolder & { imageCount: number }>> {
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
