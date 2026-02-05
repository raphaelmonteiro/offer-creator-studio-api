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
exports.TemplatesController = void 0;
const common_1 = require("@nestjs/common");
const multer_util_1 = require("../../common/utils/multer.util");
const swagger_1 = require("@nestjs/swagger");
const templates_service_1 = require("./templates.service");
const create_template_dto_1 = require("./dto/create-template.dto");
const update_template_dto_1 = require("./dto/update-template.dto");
const query_template_dto_1 = require("./dto/query-template.dto");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const uploads_service_1 = require("../uploads/uploads.service");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let TemplatesController = class TemplatesController {
    constructor(templatesService, uploadsService) {
        this.templatesService = templatesService;
        this.uploadsService = uploadsService;
    }
    create(createTemplateDto) {
        return this.templatesService.create(createTemplateDto);
    }
    findAll(query) {
        return this.templatesService.findAll(query);
    }
    findOne(id) {
        return this.templatesService.findOne(id);
    }
    update(id, updateTemplateDto) {
        return this.templatesService.update(id, updateTemplateDto);
    }
    remove(id) {
        return this.templatesService.remove(id).then(() => ({
            message: 'Template removido com sucesso',
        }));
    }
    async uploadThumbnail(id, file) {
        const upload = await this.uploadsService.uploadFile(file, 'thumbnails');
        const template = await this.templatesService.updateThumbnail(id, upload.url);
        return { thumbnailUrl: template.thumbnailUrl };
    }
};
exports.TemplatesController = TemplatesController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Cria um novo template' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Template criado com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_template_dto_1.CreateTemplateDto]),
    __metadata("design:returntype", void 0)
], TemplatesController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todos os templates' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de templates' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [query_template_dto_1.QueryTemplateDto]),
    __metadata("design:returntype", void 0)
], TemplatesController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Retorna um template específico' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Template encontrado' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Template não encontrado' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], TemplatesController.prototype, "findOne", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Atualiza um template' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Template atualizado' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_template_dto_1.UpdateTemplateDto]),
    __metadata("design:returntype", void 0)
], TemplatesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove um template (apenas templates não-padrão)' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Template removido' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], TemplatesController.prototype, "remove", null);
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
    (0, swagger_1.ApiOperation)({ summary: 'Upload/atualiza o thumbnail do template' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Thumbnail enviado com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], TemplatesController.prototype, "uploadThumbnail", null);
exports.TemplatesController = TemplatesController = __decorate([
    (0, swagger_1.ApiTags)('Templates'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('templates'),
    __metadata("design:paramtypes", [templates_service_1.TemplatesService,
        uploads_service_1.UploadsService])
], TemplatesController);
//# sourceMappingURL=templates.controller.js.map