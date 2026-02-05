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
exports.GalleryController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const gallery_service_1 = require("./gallery.service");
const query_gallery_dto_1 = require("./dto/query-gallery.dto");
const upload_gallery_dto_1 = require("./dto/upload-gallery.dto");
const delete_many_dto_1 = require("./dto/delete-many.dto");
const move_images_dto_1 = require("./dto/move-images.dto");
const create_folder_dto_1 = require("./dto/create-folder.dto");
const update_folder_dto_1 = require("./dto/update-folder.dto");
const platform_express_1 = require("@nestjs/platform-express");
const multer_util_1 = require("../../common/utils/multer.util");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let GalleryController = class GalleryController {
    constructor(galleryService) {
        this.galleryService = galleryService;
    }
    listImages(query) {
        return this.galleryService.listImages(query);
    }
    async uploadImages(files, body) {
        return this.galleryService.uploadImages(files, body.folderId);
    }
    async deleteImage(id) {
        await this.galleryService.deleteImage(id);
        return { success: true };
    }
    deleteMany(dto) {
        return this.galleryService.deleteMany(dto);
    }
    moveImages(dto) {
        return this.galleryService.moveImages(dto);
    }
    listFolders() {
        return this.galleryService.listFolders();
    }
    createFolder(dto) {
        return this.galleryService.createFolder(dto);
    }
    updateFolder(id, dto) {
        return this.galleryService.updateFolder(id, dto);
    }
    async deleteFolder(id) {
        return this.galleryService.deleteFolder(id);
    }
};
exports.GalleryController = GalleryController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista imagens com paginação e filtros' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de imagens' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [query_gallery_dto_1.QueryGalleryDto]),
    __metadata("design:returntype", void 0)
], GalleryController.prototype, "listImages", null);
__decorate([
    (0, common_1.Post)('upload'),
    (0, skip_validation_decorator_1.SkipValidation)(),
    (0, common_1.UseInterceptors)((0, platform_express_1.AnyFilesInterceptor)(multer_util_1.fileUploadOptions)),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: {
                        type: 'string',
                        format: 'binary',
                    },
                },
                folderId: {
                    type: 'string',
                    format: 'uuid',
                    nullable: true,
                },
            },
        },
    }),
    (0, swagger_1.ApiOperation)({ summary: 'Upload de múltiplas imagens' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Imagens enviadas com sucesso' }),
    __param(0, (0, common_1.UploadedFiles)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Array, upload_gallery_dto_1.UploadGalleryDto]),
    __metadata("design:returntype", Promise)
], GalleryController.prototype, "uploadImages", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove uma imagem' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Imagem removida com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], GalleryController.prototype, "deleteImage", null);
__decorate([
    (0, common_1.Post)('delete-many'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove múltiplas imagens' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Imagens removidas com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [delete_many_dto_1.DeleteManyDto]),
    __metadata("design:returntype", void 0)
], GalleryController.prototype, "deleteMany", null);
__decorate([
    (0, common_1.Post)('move'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Move imagens para uma pasta' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Imagens movidas com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [move_images_dto_1.MoveImagesDto]),
    __metadata("design:returntype", void 0)
], GalleryController.prototype, "moveImages", null);
__decorate([
    (0, common_1.Get)('folders'),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todas as pastas' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de pastas' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], GalleryController.prototype, "listFolders", null);
__decorate([
    (0, common_1.Post)('folders'),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Cria nova pasta' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Pasta criada com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_folder_dto_1.CreateFolderDto]),
    __metadata("design:returntype", void 0)
], GalleryController.prototype, "createFolder", null);
__decorate([
    (0, common_1.Patch)('folders/:id'),
    (0, swagger_1.ApiOperation)({ summary: 'Atualiza pasta' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Pasta atualizada com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_folder_dto_1.UpdateFolderDto]),
    __metadata("design:returntype", void 0)
], GalleryController.prototype, "updateFolder", null);
__decorate([
    (0, common_1.Delete)('folders/:id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({
        summary: 'Remove pasta (imagens são movidas para raiz automaticamente)',
    }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Pasta removida com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], GalleryController.prototype, "deleteFolder", null);
exports.GalleryController = GalleryController = __decorate([
    (0, swagger_1.ApiTags)('Gallery'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('gallery'),
    __metadata("design:paramtypes", [gallery_service_1.GalleryService])
], GalleryController);
//# sourceMappingURL=gallery.controller.js.map