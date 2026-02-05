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
exports.FlyersService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const flyer_entity_1 = require("./entities/flyer.entity");
const pagination_util_1 = require("../../common/utils/pagination.util");
let FlyersService = class FlyersService {
    constructor(flyerRepository) {
        this.flyerRepository = flyerRepository;
    }
    async create(createFlyerDto) {
        try {
            const configSize = JSON.stringify(createFlyerDto.configuration).length;
            const maxSize = 10 * 1024 * 1024;
            if (configSize > maxSize) {
                throw new common_1.BadRequestException({
                    code: 'CONFIGURATION_TOO_LARGE',
                    message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
                });
            }
            const flyer = this.flyerRepository.create({
                name: createFlyerDto.name,
                clientId: createFlyerDto.clientId || null,
                configuration: createFlyerDto.configuration,
                status: 'draft',
            });
            return await this.flyerRepository.save(flyer);
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
                code: 'FLYER_CREATION_ERROR',
                message: 'Erro ao criar encarte',
                details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
            });
        }
    }
    async findAll(query) {
        const { page = 1, limit = 20, search, clientId, startDate, endDate } = query;
        const skip = (page - 1) * limit;
        const where = {};
        if (search) {
            where.name = (0, typeorm_2.Like)(`%${search}%`);
        }
        if (clientId) {
            where.clientId = clientId;
        }
        if (startDate || endDate) {
            if (startDate && endDate) {
                where.createdAt = (0, typeorm_2.Between)(new Date(startDate), new Date(endDate));
            }
            else if (startDate) {
                where.createdAt = (0, typeorm_2.Between)(new Date(startDate), new Date());
            }
            else if (endDate) {
                where.createdAt = (0, typeorm_2.Between)(new Date(0), new Date(endDate));
            }
        }
        const queryBuilder = this.flyerRepository.createQueryBuilder('flyer')
            .leftJoinAndSelect('flyer.client', 'client');
        if (search) {
            queryBuilder.where('flyer.name LIKE :search', { search: `%${search}%` });
        }
        if (clientId) {
            queryBuilder.andWhere('flyer.clientId = :clientId', { clientId });
        }
        if (startDate || endDate) {
            if (startDate && endDate) {
                queryBuilder.andWhere('flyer.createdAt BETWEEN :startDate AND :endDate', {
                    startDate,
                    endDate,
                });
            }
            else if (startDate) {
                queryBuilder.andWhere('flyer.createdAt >= :startDate', { startDate });
            }
            else if (endDate) {
                queryBuilder.andWhere('flyer.createdAt <= :endDate', { endDate });
            }
        }
        queryBuilder.skip(skip).take(limit).orderBy('flyer.createdAt', 'DESC');
        const [flyers, total] = await queryBuilder.getManyAndCount();
        const transformedFlyers = flyers.map((flyer) => ({
            ...flyer,
            clientName: flyer.client?.name || null,
        }));
        return (0, pagination_util_1.paginate)(transformedFlyers, total, { page, limit });
    }
    async findOne(id) {
        const flyer = await this.flyerRepository.findOne({
            where: { id },
            relations: ['client'],
        });
        if (!flyer) {
            throw new common_1.NotFoundException({
                code: 'FLYER_NOT_FOUND',
                message: 'Encarte não encontrado',
            });
        }
        return {
            ...flyer,
            clientName: flyer.client?.name || null,
        };
    }
    async update(id, updateFlyerDto) {
        try {
            const flyer = await this.flyerRepository.findOne({
                where: { id },
            });
            if (!flyer) {
                throw new common_1.NotFoundException({
                    code: 'FLYER_NOT_FOUND',
                    message: 'Encarte não encontrado',
                });
            }
            if (updateFlyerDto.configuration) {
                const configSize = JSON.stringify(updateFlyerDto.configuration).length;
                const maxSize = 10 * 1024 * 1024;
                if (configSize > maxSize) {
                    throw new common_1.BadRequestException({
                        code: 'CONFIGURATION_TOO_LARGE',
                        message: `A configuração é muito grande (${(configSize / 1024 / 1024).toFixed(2)}MB). Tente reduzir o tamanho das imagens base64 ou usar URLs de imagens.`,
                    });
                }
            }
            Object.assign(flyer, updateFlyerDto);
            return await this.flyerRepository.save(flyer);
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
                code: 'FLYER_UPDATE_ERROR',
                message: 'Erro ao atualizar encarte',
                details: process.env.NODE_ENV !== 'production' ? (error instanceof Error ? error.message : String(error)) : undefined,
            });
        }
    }
    async remove(id) {
        const flyer = await this.flyerRepository.findOne({ where: { id } });
        if (!flyer) {
            throw new common_1.NotFoundException({
                code: 'FLYER_NOT_FOUND',
                message: 'Encarte não encontrado',
            });
        }
        await this.flyerRepository.remove(flyer);
    }
    async duplicate(id, duplicateDto) {
        const originalFlyer = await this.flyerRepository.findOne({
            where: { id },
        });
        if (!originalFlyer) {
            throw new common_1.NotFoundException({
                code: 'FLYER_NOT_FOUND',
                message: 'Encarte não encontrado',
            });
        }
        const newFlyer = this.flyerRepository.create({
            name: duplicateDto.name,
            clientId: originalFlyer.clientId,
            configuration: originalFlyer.configuration,
            status: 'draft',
        });
        return this.flyerRepository.save(newFlyer);
    }
    async updateThumbnail(id, thumbnailUrl) {
        const flyer = await this.flyerRepository.findOne({ where: { id } });
        if (!flyer) {
            throw new common_1.NotFoundException({
                code: 'FLYER_NOT_FOUND',
                message: 'Encarte não encontrado',
            });
        }
        flyer.thumbnailUrl = thumbnailUrl;
        return this.flyerRepository.save(flyer);
    }
    async export(id, format, quality) {
        const flyer = await this.findOne(id);
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const downloadUrl = `${baseUrl}/exports/${id}_${Date.now()}.${format}`;
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);
        return { downloadUrl, expiresAt };
    }
};
exports.FlyersService = FlyersService;
exports.FlyersService = FlyersService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(flyer_entity_1.Flyer)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], FlyersService);
//# sourceMappingURL=flyers.service.js.map