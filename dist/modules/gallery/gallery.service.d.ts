import { Repository } from 'typeorm';
import { GalleryImage } from './entities/gallery-image.entity';
import { GalleryFolder } from './entities/gallery-folder.entity';
import { QueryGalleryDto } from './dto/query-gallery.dto';
import { UploadsService } from '../uploads/uploads.service';
import { PaginationResult } from '../../common/utils/pagination.util';
import { DeleteManyDto } from './dto/delete-many.dto';
import { MoveImagesDto } from './dto/move-images.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
export declare class GalleryService {
    private readonly imagesRepository;
    private readonly foldersRepository;
    private readonly uploadsService;
    constructor(imagesRepository: Repository<GalleryImage>, foldersRepository: Repository<GalleryFolder>, uploadsService: UploadsService);
    listImages(query: QueryGalleryDto): Promise<PaginationResult<GalleryImage>>;
    uploadImages(files: Express.Multer.File[], folderId?: string | null): Promise<GalleryImage[]>;
    deleteImage(id: string): Promise<void>;
    deleteMany(dto: DeleteManyDto): Promise<{
        success: boolean;
        deleted: number;
    }>;
    moveImages(dto: MoveImagesDto): Promise<{
        success: boolean;
        moved: number;
    }>;
    listFolders(): Promise<Array<GalleryFolder & {
        imageCount: number;
    }>>;
    createFolder(dto: CreateFolderDto): Promise<GalleryFolder & {
        imageCount: number;
    }>;
    updateFolder(id: string, dto: UpdateFolderDto): Promise<GalleryFolder & {
        imageCount: number;
    }>;
    deleteFolder(id: string): Promise<{
        success: boolean;
    }>;
}
