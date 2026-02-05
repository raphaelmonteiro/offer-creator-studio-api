"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GalleryService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const gallery_image_entity_1 = require("./entities/gallery-image.entity");
const gallery_folder_entity_1 = require("./entities/gallery-folder.entity");
const uploads_service_1 = require("../uploads/uploads.service");
const pagination_util_1 = require("../../common/utils/pagination.util");
let GalleryService = class GalleryService {
    constructor(imagesRepository, foldersRepository, uploadsService) {
        this.imagesRepository = imagesRepository;
        this.foldersRepository = foldersRepository;
        this.uploadsService = uploadsService;
    }
    async listImages(query) {
        const { page = 1, limit = 20, search, folderId } = query;
        const skip = (page - 1) * limit;
        const qb = this.imagesRepository.createQueryBuilder('image');
        if (search) {
            qb.where('image.filename LIKE :search', { search: `%${search}%` });
        }
        if (folderId === 'none') {
            qb.andWhere('image.folderId IS NULL');
        }
        else if (folderId) {
            qb.andWhere('image.folderId = :folderId', { folderId });
        }
        qb.orderBy('image.createdAt', 'DESC').skip(skip).take(limit);
        const [items, total] = await qb.getManyAndCount();
        return (0, pagination_util_1.paginate)(items, total, { page, limit });
    }
    async uploadImages(files, folderId) {
        const images = [];
        for (const file of files) {
            const uploaded = await this.uploadsService.uploadFile(file, 'gallery');
            const image = this.imagesRepository.create({
                filename: uploaded.filename,
                url: uploaded.url,
                thumbnailUrl: uploaded.url,
                mimeType: uploaded.mimeType,
                size: uploaded.size,
                folderId: folderId || null,
            });
            images.push(await this.imagesRepository.save(image));
        }
        return images;
    }
    async deleteImage(id) {
        const image = await this.imagesRepository.findOne({ where: { id } });
        if (!image) {
            throw new common_1.NotFoundException({
                code: 'GALLERY_IMAGE_NOT_FOUND',
                message: 'Imagem não encontrada',
            });
        }
        await this.imagesRepository.remove(image);
    }
    async deleteMany(dto) {
        const result = await this.imagesRepository.delete(dto.ids);
        return {
            success: true,
            deleted: result.affected || 0,
        };
    }
    async moveImages(dto) {
        const { imageIds, folderId } = dto;
        await this.imagesRepository
            .createQueryBuilder()
            .update(gallery_image_entity_1.GalleryImage)
            .set({ folderId: folderId || null })
            .where('id IN (:...ids)', { ids: imageIds })
            .execute();
        return {
            success: true,
            moved: imageIds.length,
        };
    }
    async listFolders() {
        const folders = await this.foldersRepository.find();
        const counts = await this.imagesRepository
            .createQueryBuilder('image')
            .select('image.folderId', 'folderId')
            .addSelect('COUNT(*)', 'count')
            .groupBy('image.folderId')
            .getRawMany();
        const map = new Map();
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
    async createFolder(dto) {
        const folder = this.foldersRepository.create({
            name: dto.name,
            color: dto.color || null,
        });
        const saved = await this.foldersRepository.save(folder);
        return { ...saved, imageCount: 0 };
    }
    async updateFolder(id, dto) {
        const folder = await this.foldersRepository.findOne({ where: { id } });
        if (!folder) {
            throw new common_1.NotFoundException({
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
    async deleteFolder(id) {
        const folder = await this.foldersRepository.findOne({ where: { id } });
        if (!folder) {
            throw new common_1.NotFoundException({
                code: 'GALLERY_FOLDER_NOT_FOUND',
                message: 'Pasta não encontrada',
            });
        }
        await this.imagesRepository
            .createQueryBuilder()
            .update(gallery_image_entity_1.GalleryImage)
            .set({ folderId: null })
            .where('folderId = :id', { id })
            .execute();
        await this.foldersRepository.remove(folder);
        return { success: true };
    }
};
exports.GalleryService = GalleryService;
exports.GalleryService = GalleryService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(gallery_image_entity_1.GalleryImage)),
    __param(1, (0, typeorm_1.InjectRepository)(gallery_folder_entity_1.GalleryFolder)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        uploads_service_1.UploadsService])
], GalleryService);
//# sourceMappingURL=gallery.service.js.map