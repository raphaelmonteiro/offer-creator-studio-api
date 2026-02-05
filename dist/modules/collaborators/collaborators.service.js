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
exports.CollaboratorsService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const user_entity_1 = require("../auth/entities/user.entity");
const pagination_util_1 = require("../../common/utils/pagination.util");
let CollaboratorsService = class CollaboratorsService {
    constructor(userRepository) {
        this.userRepository = userRepository;
    }
    async create(createCollaboratorDto) {
        const existingUser = await this.userRepository.findOne({
            where: { email: createCollaboratorDto.email },
        });
        if (existingUser) {
            throw new common_1.ConflictException({
                code: 'EMAIL_ALREADY_EXISTS',
                message: 'Email já cadastrado',
            });
        }
        const user = this.userRepository.create({
            ...createCollaboratorDto,
            role: createCollaboratorDto.role || 'collaborator',
            emailVerified: false,
        });
        const savedUser = await this.userRepository.save(user);
        const { password, ...userWithoutPassword } = savedUser;
        return userWithoutPassword;
    }
    async findAll(query) {
        const { page = 1, limit = 20, search, role } = query;
        const skip = (page - 1) * limit;
        const queryBuilder = this.userRepository.createQueryBuilder('user');
        if (search) {
            queryBuilder.where('(user.name LIKE :search OR user.email LIKE :search)', { search: `%${search}%` });
        }
        if (role) {
            queryBuilder.andWhere('user.role = :role', { role });
        }
        queryBuilder.skip(skip).take(limit).orderBy('user.createdAt', 'DESC');
        const [users, total] = await queryBuilder.getManyAndCount();
        const usersWithoutPassword = users.map(({ password, ...user }) => user);
        return (0, pagination_util_1.paginate)(usersWithoutPassword, total, { page, limit });
    }
    async findOne(id) {
        const user = await this.userRepository.findOne({
            where: { id },
        });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'COLLABORATOR_NOT_FOUND',
                message: 'Colaborador não encontrado',
            });
        }
        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }
    async update(id, updateCollaboratorDto) {
        const user = await this.userRepository.findOne({
            where: { id },
        });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'COLLABORATOR_NOT_FOUND',
                message: 'Colaborador não encontrado',
            });
        }
        if (updateCollaboratorDto.email && updateCollaboratorDto.email !== user.email) {
            const existingUser = await this.userRepository.findOne({
                where: { email: updateCollaboratorDto.email },
            });
            if (existingUser) {
                throw new common_1.ConflictException({
                    code: 'EMAIL_ALREADY_EXISTS',
                    message: 'Email já cadastrado',
                });
            }
        }
        Object.assign(user, updateCollaboratorDto);
        const updatedUser = await this.userRepository.save(user);
        const { password, ...userWithoutPassword } = updatedUser;
        return userWithoutPassword;
    }
    async remove(id) {
        const user = await this.userRepository.findOne({
            where: { id },
        });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'COLLABORATOR_NOT_FOUND',
                message: 'Colaborador não encontrado',
            });
        }
        await this.userRepository.remove(user);
    }
    async updateAvatar(id, avatarUrl) {
        const user = await this.userRepository.findOne({
            where: { id },
        });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'COLLABORATOR_NOT_FOUND',
                message: 'Colaborador não encontrado',
            });
        }
        user.avatarUrl = avatarUrl;
        const updatedUser = await this.userRepository.save(user);
        const { password, ...userWithoutPassword } = updatedUser;
        return userWithoutPassword;
    }
};
exports.CollaboratorsService = CollaboratorsService;
exports.CollaboratorsService = CollaboratorsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], CollaboratorsService);
//# sourceMappingURL=collaborators.service.js.map