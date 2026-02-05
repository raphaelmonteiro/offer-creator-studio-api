import { GalleryService } from './gallery.service';
import { QueryGalleryDto } from './dto/query-gallery.dto';
import { UploadGalleryDto } from './dto/upload-gallery.dto';
import { DeleteManyDto } from './dto/delete-many.dto';
import { MoveImagesDto } from './dto/move-images.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
export declare class GalleryController {
    private readonly galleryService;
    constructor(galleryService: GalleryService);
    listImages(query: QueryGalleryDto): Promise<import("../../common/utils/pagination.util").PaginationResult<import("./entities/gallery-image.entity").GalleryImage>>;
    uploadImages(files: Express.Multer.File[], body: UploadGalleryDto): Promise<import("./entities/gallery-image.entity").GalleryImage[]>;
    deleteImage(id: string): Promise<{
        success: boolean;
    }>;
    deleteMany(dto: DeleteManyDto): Promise<{
        success: boolean;
        deleted: number;
    }>;
    moveImages(dto: MoveImagesDto): Promise<{
        success: boolean;
        moved: number;
    }>;
    listFolders(): Promise<(import("./entities/gallery-folder.entity").GalleryFolder & {
        imageCount: number;
    })[]>;
    createFolder(dto: CreateFolderDto): Promise<import("./entities/gallery-folder.entity").GalleryFolder & {
        imageCount: number;
    }>;
    updateFolder(id: string, dto: UpdateFolderDto): Promise<import("./entities/gallery-folder.entity").GalleryFolder & {
        imageCount: number;
    }>;
    deleteFolder(id: string): Promise<{
        success: boolean;
    }>;
}
