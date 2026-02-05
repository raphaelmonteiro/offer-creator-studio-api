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
exports.TemplatesService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const template_entity_1 = require("./entities/template.entity");
const pagination_util_1 = require("../../common/utils/pagination.util");
let TemplatesService = class TemplatesService {
    constructor(templateRepository) {
        this.templateRepository = templateRepository;
    }
    async create(createTemplateDto) {
        try {
            const configSize = JSON.stringify(createTemplateDto.configuration).length;
            const maxSize = 10 * 1024 * 1024;
            if (configSize > maxSize) {
                throw new common_1.BadRequestException({
                    code: 'CONFIGURATION_TOO_LARGE',
                    message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
                });
            }
            const template = this.templateRepository.create(createTemplateDto);
            return await this.templateRepository.save(template);
        }
        catch (error) {
            if (error instanceof common_1.BadRequestException) {
                throw error;
            }
            if (error instanceof Error) {
                const errorMessage = error.message.toLowerCase();
                if (errorMessage.includes('value too long') || errorMessage.includes('exceeds maximum')) {
                    throw new common_1.BadRequestException({
                        code: 'PAYLOAD_TOO_LARGE',
                        message: 'O payload é muito grande. Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.',
                        details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
                    });
                }
                if (errorMessage.includes('invalid input syntax') || errorMessage.includes('json')) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_JSON',
                        message: 'Erro ao processar JSON na configuração. Verifique o formato dos dados.',
                        details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
                    });
                }
            }
            throw new common_1.InternalServerErrorException({
                code: 'TEMPLATE_CREATION_ERROR',
                message: 'Erro ao criar template',
                details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
            });
        }
    }
    async findAll(query) {
        const { page = 1, limit = 20, search, type, isDefault } = query;
        const skip = (page - 1) * limit;
        const where = {};
        if (search) {
            where.name = (0, typeorm_2.Like)(`%${search}%`);
        }
        if (type) {
            where.type = type;
        }
        if (isDefault !== undefined) {
            where.isDefault = isDefault;
        }
        const queryBuilder = this.templateRepository.createQueryBuilder('template');
        if (search) {
            queryBuilder.where('template.name LIKE :search', { search: `%${search}%` });
        }
        if (type) {
            queryBuilder.andWhere('template.type = :type', { type });
        }
        if (isDefault !== undefined) {
            queryBuilder.andWhere('template.isDefault = :isDefault', { isDefault });
        }
        queryBuilder.skip(skip).take(limit).orderBy('template.createdAt', 'DESC');
        const [templates, total] = await queryBuilder.getManyAndCount();
        return (0, pagination_util_1.paginate)(templates, total, { page, limit });
    }
    async findOne(id) {
        const template = await this.templateRepository.findOne({
            where: { id },
        });
        if (!template) {
            throw new common_1.NotFoundException({
                code: 'TEMPLATE_NOT_FOUND',
                message: 'Template não encontrado',
            });
        }
        return template;
    }
    async update(id, updateTemplateDto) {
        try {
            const template = await this.findOne(id);
            if (updateTemplateDto.configuration) {
                const configSize = JSON.stringify(updateTemplateDto.configuration).length;
                const maxSize = 10 * 1024 * 1024;
                if (configSize > maxSize) {
                    throw new common_1.BadRequestException({
                        code: 'CONFIGURATION_TOO_LARGE',
                        message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
                    });
                }
            }
            Object.assign(template, updateTemplateDto);
            return await this.templateRepository.save(template);
        }
        catch (error) {
            if (error instanceof common_1.BadRequestException || error instanceof common_1.NotFoundException) {
                throw error;
            }
            if (error instanceof Error) {
                const errorMessage = error.message.toLowerCase();
                if (errorMessage.includes('value too long') || errorMessage.includes('exceeds maximum')) {
                    throw new common_1.BadRequestException({
                        code: 'PAYLOAD_TOO_LARGE',
                        message: 'O payload é muito grande. Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.',
                        details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
                    });
                }
                if (errorMessage.includes('invalid input syntax') || errorMessage.includes('json')) {
                    throw new common_1.BadRequestException({
                        code: 'INVALID_JSON',
                        message: 'Erro ao processar JSON na configuração. Verifique o formato dos dados.',
                        details: process.env.NODE_ENV !== 'production' ? error.message : undefined,
                    });
                }
            }
            throw new common_1.InternalServerErrorException({
                code: 'TEMPLATE_UPDATE_ERROR',
                message: 'Erro ao atualizar template',
                details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
            });
        }
    }
    async remove(id) {
        const template = await this.findOne(id);
        if (template.isDefault) {
            throw new common_1.BadRequestException({
                code: 'CANNOT_DELETE_DEFAULT',
                message: 'Não é possível remover templates padrão',
            });
        }
        await this.templateRepository.remove(template);
    }
    async updateThumbnail(id, thumbnailUrl) {
        const template = await this.findOne(id);
        template.thumbnailUrl = thumbnailUrl;
        return this.templateRepository.save(template);
    }
};
exports.TemplatesService = TemplatesService;
exports.TemplatesService = TemplatesService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(template_entity_1.Template)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], TemplatesService);
//# sourceMappingURL=templates.service.js.map