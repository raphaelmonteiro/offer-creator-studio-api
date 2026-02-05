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
exports.CollaboratorsController = void 0;
const common_1 = require("@nestjs/common");
const multer_util_1 = require("../../common/utils/multer.util");
const swagger_1 = require("@nestjs/swagger");
const collaborators_service_1 = require("./collaborators.service");
const create_collaborator_dto_1 = require("./dto/create-collaborator.dto");
const update_collaborator_dto_1 = require("./dto/update-collaborator.dto");
const query_collaborator_dto_1 = require("./dto/query-collaborator.dto");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const uploads_service_1 = require("../uploads/uploads.service");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let CollaboratorsController = class CollaboratorsController {
    constructor(collaboratorsService, uploadsService) {
        this.collaboratorsService = collaboratorsService;
        this.uploadsService = uploadsService;
    }
    create(createCollaboratorDto) {
        return this.collaboratorsService.create(createCollaboratorDto);
    }
    findAll(query) {
        return this.collaboratorsService.findAll(query);
    }
    findOne(id) {
        return this.collaboratorsService.findOne(id);
    }
    update(id, updateCollaboratorDto) {
        return this.collaboratorsService.update(id, updateCollaboratorDto);
    }
    remove(id) {
        return this.collaboratorsService.remove(id).then(() => ({
            message: 'Colaborador removido com sucesso',
        }));
    }
    async uploadAvatar(id, file) {
        const upload = await this.uploadsService.uploadFile(file, 'avatars');
        const collaborator = await this.collaboratorsService.updateAvatar(id, upload.url);
        return { avatarUrl: collaborator.avatarUrl };
    }
};
exports.CollaboratorsController = CollaboratorsController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Cria um novo colaborador' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Colaborador criado com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_collaborator_dto_1.CreateCollaboratorDto]),
    __metadata("design:returntype", void 0)
], CollaboratorsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todos os colaboradores' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de colaboradores' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [query_collaborator_dto_1.QueryCollaboratorDto]),
    __metadata("design:returntype", void 0)
], CollaboratorsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Retorna um colaborador específico' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Colaborador encontrado' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Colaborador não encontrado' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CollaboratorsController.prototype, "findOne", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Atualiza um colaborador' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Colaborador atualizado' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_collaborator_dto_1.UpdateCollaboratorDto]),
    __metadata("design:returntype", void 0)
], CollaboratorsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove um colaborador' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Colaborador removido' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CollaboratorsController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':id/avatar'),
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
    (0, swagger_1.ApiOperation)({ summary: 'Upload do avatar do colaborador' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Avatar enviado com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], CollaboratorsController.prototype, "uploadAvatar", null);
exports.CollaboratorsController = CollaboratorsController = __decorate([
    (0, swagger_1.ApiTags)('Collaborators'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('collaborators'),
    __metadata("design:paramtypes", [collaborators_service_1.CollaboratorsService,
        uploads_service_1.UploadsService])
], CollaboratorsController);
//# sourceMappingURL=collaborators.controller.js.map