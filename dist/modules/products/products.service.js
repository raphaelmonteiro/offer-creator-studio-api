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
exports.ProductsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const product_entity_1 = require("./entities/product.entity");
const pagination_util_1 = require("../../common/utils/pagination.util");
let ProductsService = class ProductsService {
    constructor(productRepository) {
        this.productRepository = productRepository;
    }
    async create(createProductDto) {
        if (createProductDto.sku) {
            const existingProduct = await this.productRepository.findOne({
                where: { sku: createProductDto.sku },
            });
            if (existingProduct) {
                throw new common_1.ConflictException({
                    code: 'SKU_ALREADY_EXISTS',
                    message: 'SKU já cadastrado',
                });
            }
        }
        const product = this.productRepository.create(createProductDto);
        return this.productRepository.save(product);
    }
    async findAll(query) {
        const { page = 1, limit = 20, search, category, minPrice, maxPrice } = query;
        const skip = (page - 1) * limit;
        const where = {};
        if (category) {
            where.category = category;
        }
        if (minPrice !== undefined || maxPrice !== undefined) {
            if (minPrice !== undefined && maxPrice !== undefined) {
                where.price = (0, typeorm_2.Between)(minPrice, maxPrice);
            }
            else if (minPrice !== undefined) {
                where.price = (0, typeorm_2.Between)(minPrice, 999999);
            }
            else if (maxPrice !== undefined) {
                where.price = (0, typeorm_2.Between)(0, maxPrice);
            }
        }
        const queryBuilder = this.productRepository.createQueryBuilder('product');
        queryBuilder.where('product.active = :active', { active: true });
        if (search) {
            queryBuilder.andWhere('(product.name LIKE :search OR product.sku LIKE :search)', { search: `%${search}%` });
        }
        if (category) {
            queryBuilder.andWhere('product.category = :category', { category });
        }
        if (minPrice !== undefined) {
            queryBuilder.andWhere('product.price >= :minPrice', { minPrice });
        }
        if (maxPrice !== undefined) {
            queryBuilder.andWhere('product.price <= :maxPrice', { maxPrice });
        }
        queryBuilder.skip(skip).take(limit).orderBy('product.createdAt', 'DESC');
        const [products, total] = await queryBuilder.getManyAndCount();
        return (0, pagination_util_1.paginate)(products, total, { page, limit });
    }
    async findOne(id) {
        const product = await this.productRepository.findOne({ where: { id } });
        if (!product) {
            throw new common_1.NotFoundException({
                code: 'PRODUCT_NOT_FOUND',
                message: 'Produto não encontrado',
            });
        }
        return product;
    }
    async update(id, updateProductDto) {
        const product = await this.findOne(id);
        if (updateProductDto.sku && updateProductDto.sku !== product.sku) {
            const existingProduct = await this.productRepository.findOne({
                where: { sku: updateProductDto.sku },
            });
            if (existingProduct) {
                throw new common_1.ConflictException({
                    code: 'SKU_ALREADY_EXISTS',
                    message: 'SKU já cadastrado',
                });
            }
        }
        Object.assign(product, updateProductDto);
        return this.productRepository.save(product);
    }
    async remove(id) {
        const product = await this.findOne(id);
        product.active = false;
        await this.productRepository.save(product);
    }
    async updateImage(id, imageUrl) {
        const product = await this.findOne(id);
        product.imageUrl = imageUrl;
        return this.productRepository.save(product);
    }
};
exports.ProductsService = ProductsService;
exports.ProductsService = ProductsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(product_entity_1.Product)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], ProductsService);
//# sourceMappingURL=products.service.js.map