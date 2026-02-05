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
exports.FontsController = void 0;
const common_1 = require("@nestjs/common");
const multer_util_1 = require("../../common/utils/multer.util");
const swagger_1 = require("@nestjs/swagger");
const fonts_service_1 = require("./fonts.service");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const uploads_service_1 = require("../uploads/uploads.service");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let FontsController = class FontsController {
    constructor(fontsService, uploadsService) {
        this.fontsService = fontsService;
        this.uploadsService = uploadsService;
    }
    async create(file, body) {
        if (!file) {
            throw new common_1.BadRequestException({
                code: 'FILE_REQUIRED',
                message: 'Arquivo é obrigatório',
            });
        }
        const { family, weight, style } = body;
        if (!family || !weight || !style) {
            throw new common_1.BadRequestException({
                code: 'MISSING_FIELDS',
                message: 'Campos obrigatórios: family, weight, style',
            });
        }
        this.fontsService.validateFontFile(file.originalname);
        const upload = await this.uploadsService.uploadFile(file, 'fonts');
        const createFontDto = {
            family: String(family),
            weight: String(weight),
            style: String(style),
        };
        return this.fontsService.create(createFontDto, upload.url);
    }
    findAll() {
        return this.fontsService.findAll();
    }
    remove(id) {
        return this.fontsService.remove(id).then(() => ({
            message: 'Fonte removida com sucesso',
        }));
    }
};
exports.FontsController = FontsController;
__decorate([
    (0, common_1.Post)(),
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
                family: {
                    type: 'string',
                    example: 'Bebas Neue',
                },
                weight: {
                    type: 'string',
                    example: '400',
                },
                style: {
                    type: 'string',
                    example: 'normal',
                },
            },
        },
    }),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Upload de nova fonte' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Fonte criada com sucesso' }),
    __param(0, (0, common_1.UploadedFile)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], FontsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todas as fontes personalizadas' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de fontes' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], FontsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove uma fonte' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Fonte removida' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FontsController.prototype, "remove", null);
exports.FontsController = FontsController = __decorate([
    (0, swagger_1.ApiTags)('Fonts'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('fonts'),
    __metadata("design:paramtypes", [fonts_service_1.FontsService,
        uploads_service_1.UploadsService])
], FontsController);
//# sourceMappingURL=fonts.controller.js.map