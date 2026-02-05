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
exports.ClientsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const client_entity_1 = require("./entities/client.entity");
const client_contact_entity_1 = require("./entities/client-contact.entity");
const pagination_util_1 = require("../../common/utils/pagination.util");
let ClientsService = class ClientsService {
    constructor(clientRepository, contactRepository) {
        this.clientRepository = clientRepository;
        this.contactRepository = contactRepository;
    }
    async create(createClientDto) {
        const existingClient = await this.clientRepository.findOne({
            where: { cnpj: createClientDto.cnpj },
        });
        if (existingClient) {
            throw new common_1.ConflictException({
                code: 'CNPJ_ALREADY_EXISTS',
                message: 'CNPJ já cadastrado',
            });
        }
        const client = this.clientRepository.create({
            name: createClientDto.name,
            cnpj: createClientDto.cnpj,
            logoUrl: createClientDto.logoUrl || null,
        });
        const savedClient = await this.clientRepository.save(client);
        if (createClientDto.contacts && createClientDto.contacts.length > 0) {
            const contacts = createClientDto.contacts.map((contactDto) => this.contactRepository.create({
                ...contactDto,
                clientId: savedClient.id,
            }));
            await this.contactRepository.save(contacts);
        }
        return this.findOne(savedClient.id);
    }
    async findAll(query) {
        const { page = 1, limit = 20, search } = query;
        const skip = (page - 1) * limit;
        const where = {};
        if (search) {
            where.name = (0, typeorm_2.Like)(`%${search}%`);
        }
        const queryBuilder = this.clientRepository.createQueryBuilder('client')
            .leftJoinAndSelect('client.contacts', 'contacts');
        if (search) {
            queryBuilder.where('(client.name LIKE :search OR client.cnpj LIKE :search)', { search: `%${search}%` });
        }
        queryBuilder.skip(skip).take(limit).orderBy('client.createdAt', 'DESC');
        const [clients, total] = await queryBuilder.getManyAndCount();
        return (0, pagination_util_1.paginate)(clients, total, { page, limit });
    }
    async findOne(id) {
        const client = await this.clientRepository.findOne({
            where: { id },
            relations: ['contacts'],
        });
        if (!client) {
            throw new common_1.NotFoundException({
                code: 'CLIENT_NOT_FOUND',
                message: 'Cliente não encontrado',
            });
        }
        return client;
    }
    async update(id, updateClientDto) {
        const client = await this.findOne(id);
        if (updateClientDto.cnpj && updateClientDto.cnpj !== client.cnpj) {
            const existingClient = await this.clientRepository.findOne({
                where: { cnpj: updateClientDto.cnpj },
            });
            if (existingClient) {
                throw new common_1.ConflictException({
                    code: 'CNPJ_ALREADY_EXISTS',
                    message: 'CNPJ já cadastrado',
                });
            }
        }
        if (updateClientDto.name) {
            client.name = updateClientDto.name;
        }
        if (updateClientDto.cnpj) {
            client.cnpj = updateClientDto.cnpj;
        }
        if (updateClientDto.logoUrl !== undefined) {
            client.logoUrl = updateClientDto.logoUrl;
        }
        await this.clientRepository.save(client);
        if (updateClientDto.contacts) {
            await this.contactRepository.delete({ clientId: id });
            if (updateClientDto.contacts.length > 0) {
                const contacts = updateClientDto.contacts.map((contactDto) => this.contactRepository.create({
                    ...contactDto,
                    clientId: id,
                }));
                await this.contactRepository.save(contacts);
            }
        }
        return this.findOne(id);
    }
    async remove(id) {
        const client = await this.findOne(id);
        await this.clientRepository.remove(client);
    }
    async updateLogo(id, logoUrl) {
        const client = await this.findOne(id);
        client.logoUrl = logoUrl;
        return this.clientRepository.save(client);
    }
};
exports.ClientsService = ClientsService;
exports.ClientsService = ClientsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(client_entity_1.Client)),
    __param(1, (0, typeorm_1.InjectRepository)(client_contact_entity_1.ClientContact)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
], ClientsService);
//# sourceMappingURL=clients.service.js.map