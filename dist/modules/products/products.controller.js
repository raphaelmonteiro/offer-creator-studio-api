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
exports.ProductsController = void 0;
const common_1 = require("@nestjs/common");
const multer_util_1 = require("../../common/utils/multer.util");
const swagger_1 = require("@nestjs/swagger");
const products_service_1 = require("./products.service");
const create_product_dto_1 = require("./dto/create-product.dto");
const update_product_dto_1 = require("./dto/update-product.dto");
const query_product_dto_1 = require("./dto/query-product.dto");
const jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");
const uploads_service_1 = require("../uploads/uploads.service");
const skip_validation_decorator_1 = require("../../common/decorators/skip-validation.decorator");
let ProductsController = class ProductsController {
    constructor(productsService, uploadsService) {
        this.productsService = productsService;
        this.uploadsService = uploadsService;
    }
    create(createProductDto) {
        return this.productsService.create(createProductDto);
    }
    findAll(query) {
        return this.productsService.findAll(query);
    }
    findOne(id) {
        return this.productsService.findOne(id);
    }
    update(id, updateProductDto) {
        return this.productsService.update(id, updateProductDto);
    }
    remove(id) {
        return this.productsService.remove(id).then(() => ({
            message: 'Produto removido com sucesso',
        }));
    }
    async uploadImage(id, file) {
        const upload = await this.uploadsService.uploadFile(file, 'products');
        const product = await this.productsService.updateImage(id, upload.url);
        return { imageUrl: product.imageUrl };
    }
};
exports.ProductsController = ProductsController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.CREATED),
    (0, swagger_1.ApiOperation)({ summary: 'Cria um novo produto' }),
    (0, swagger_1.ApiResponse)({ status: 201, description: 'Produto criado com sucesso' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_product_dto_1.CreateProductDto]),
    __metadata("design:returntype", void 0)
], ProductsController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Lista todos os produtos' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Lista de produtos' }),
    __param(0, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [query_product_dto_1.QueryProductDto]),
    __metadata("design:returntype", void 0)
], ProductsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Retorna um produto específico' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Produto encontrado' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Produto não encontrado' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProductsController.prototype, "findOne", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Atualiza um produto' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Produto atualizado' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_product_dto_1.UpdateProductDto]),
    __metadata("design:returntype", void 0)
], ProductsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Remove um produto (soft delete)' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Produto removido' }),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], ProductsController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':id/image'),
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
    (0, swagger_1.ApiOperation)({ summary: 'Upload da imagem do produto' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Imagem enviada com sucesso' }),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ProductsController.prototype, "uploadImage", null);
exports.ProductsController = ProductsController = __decorate([
    (0, swagger_1.ApiTags)('Products'),
    (0, swagger_1.ApiBearerAuth)('JWT-auth'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('products'),
    __metadata("design:paramtypes", [products_service_1.ProductsService,
        uploads_service_1.UploadsService])
], ProductsController);
//# sourceMappingURL=products.controller.js.map