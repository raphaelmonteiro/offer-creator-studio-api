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
exports.FlyersController = void 0;
const common_1 = require("@nestjs/common");
const multer_util_1 = require("../../common/utils/multer.util");
const swagger_1 = require("@nestjs/swagger");
const flyers_service_1 = require("./flyers.service");
const create_flyer_dto_1 = require("./dto/create-flyer.dto");
const update_flyer_dto_1 = require("./dto/update-flyer.dto");
const query_flyer_dto_1 = require("./dto/query-flyer.dto");
const duplicate_flyer_dto_1 = require("./dto/duplicate-flyer.dto");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const uploads_service_1 = require("../uploads/uploads.service");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let FlyersController = class FlyersController {
    constructor(flyersService, uploadsService) {
        this.flyersService = flyersService;
        this.uploadsService = uploadsService;
    }
    create(createFlyerDto) {
        return this.flyersService.create(createFlyerDto);
    }
    findAll(query) {
        return this.flyersService.findAll(query);
    }
    findOne(id) {
        return this.flyersService.findOne(id);
    }
    update(id, updateFlyerDto) {
        return this.flyersService.update(id, updateFlyerDto);
    }
    remove(id) {
        return this.flyersService.remove(id).then(() => ({
            message: 'Encarte removido com sucesso',
        }));
    }
    duplicate(id, duplicateDto) {
        return this.flyersService.duplicate(id, duplicateDto);
    }
    async uploadThumbnail(id, file) {
        const upload = await this.uploadsService.uploadFile(file, 'thumbnails');
        const flyer = await this.flyersService.updateThumbnail(id, upload.url);
        return { thumbnailUrl: flyer.thumbnailUrl };
    }
    async export(id, format = 'pdf', quality = 'high') {
        return this.flyersService.export(id, format, quality);
    }
};
exports.FlyersController = FlyersController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Cria um novo encarte' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Encarte criado com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_flyer_dto_1.CreateFlyerDto]),
    __metadata("design:returntype", void 0)
], FlyersController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todos os encartes' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de encartes' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [query_flyer_dto_1.QueryFlyerDto]),
    __metadata("design:returntype", void 0)
], FlyersController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Retorna um encarte específico' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Encarte encontrado' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Encarte não encontrado' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FlyersController.prototype, "findOne", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Atualiza um encarte' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Encarte atualizado' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_flyer_dto_1.UpdateFlyerDto]),
    __metadata("design:returntype", void 0)
], FlyersController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove um encarte' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Encarte removido' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FlyersController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':id/duplicate'),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Duplica um encarte' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Encarte duplicado com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, duplicate_flyer_dto_1.DuplicateFlyerDto]),
    __metadata("design:returntype", void 0)
], FlyersController.prototype, "duplicate", null);
__decorate([
    (0, common_1.Post)(':id/thumbnail'),
    (0, skip_validation_decorator_1.SkipValidation)(),
    (0, common_1.UseInterceptors)((0, multer_util_1.createFileInterceptor)('file')),
    (0, swagger_1.ApiConsumes)('multipart/form-data'),
    (0, swagger_1.ApiBody)({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
        },
    }),
    (0, swagger_1.ApiOperation)({ summary: 'Upload/atualiza o thumbnail do encarte' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Thumbnail enviado com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], FlyersController.prototype, "uploadThumbnail", null);
__decorate([
    (0, common_1.Get)(':id/export'),
    (0, swagger_1.ApiOperation)({ summary: 'Exporta o encarte em formato específico' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Exportação gerada' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Query)('format')),
    __param(2, (0, common_1.Query)('quality')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], FlyersController.prototype, "export", null);
exports.FlyersController = FlyersController = __decorate([
    (0, swagger_1.ApiTags)('Flyers'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('flyers'),
    __metadata("design:paramtypes", [flyers_service_1.FlyersService,
        uploads_service_1.UploadsService])
], FlyersController);
//# sourceMappingURL=flyers.controller.js.map