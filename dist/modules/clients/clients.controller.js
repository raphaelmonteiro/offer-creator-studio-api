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
exports.ClientsController = void 0;
const common_1 = require("@nestjs/common");
const multer_util_1 = require("../../common/utils/multer.util");
const swagger_1 = require("@nestjs/swagger");
const clients_service_1 = require("./clients.service");
const create_client_dto_1 = require("./dto/create-client.dto");
const update_client_dto_1 = require("./dto/update-client.dto");
const query_client_dto_1 = require("./dto/query-client.dto");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const uploads_service_1 = require("../uploads/uploads.service");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let ClientsController = class ClientsController {
    constructor(clientsService, uploadsService) {
        this.clientsService = clientsService;
        this.uploadsService = uploadsService;
    }
    create(createClientDto) {
        return this.clientsService.create(createClientDto);
    }
    findAll(query) {
        return this.clientsService.findAll(query);
    }
    findOne(id) {
        return this.clientsService.findOne(id);
    }
    update(id, updateClientDto) {
        return this.clientsService.update(id, updateClientDto);
    }
    remove(id) {
        return this.clientsService.remove(id).then(() => ({
            message: 'Cliente removido com sucesso',
        }));
    }
    async uploadLogo(id, file) {
        const upload = await this.uploadsService.uploadFile(file, 'logos');
        const client = await this.clientsService.updateLogo(id, upload.url);
        return { logoUrl: client.logoUrl };
    }
};
exports.ClientsController = ClientsController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Cria um novo cliente' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Cliente criado com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_client_dto_1.CreateClientDto]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todos os clientes' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de clientes' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [query_client_dto_1.QueryClientDto]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Retorna um cliente específico' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Cliente encontrado' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Cliente não encontrado' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "findOne", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Atualiza um cliente' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Cliente atualizado' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_client_dto_1.UpdateClientDto]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove um cliente' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Cliente removido' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ClientsController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':id/logo'),
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
    (0, swagger_1.ApiOperation)({ summary: 'Upload do logo do cliente' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Logo enviado com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ClientsController.prototype, "uploadLogo", null);
exports.ClientsController = ClientsController = __decorate([
    (0, swagger_1.ApiTags)('Clients'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('clients'),
    __metadata("design:paramtypes", [clients_service_1.ClientsService,
        uploads_service_1.UploadsService])
], ClientsController);
//# sourceMappingURL=clients.controller.js.map