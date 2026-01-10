import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { CreateCollaboratorDto } from './dto/create-collaborator.dto';
import { UpdateCollaboratorDto } from './dto/update-collaborator.dto';
import { QueryCollaboratorDto } from './dto/query-collaborator.dto';
import { paginate, PaginationResult } from '../../common/utils/pagination.util';

// Tipo para retornar usuário sem password e métodos
type UserWithoutPassword = Omit<User, 'password' | 'hashPassword' | 'hashPasswordIfChanged' | 'validatePassword'>;

@Injectable()
export class CollaboratorsService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {}

  async create(createCollaboratorDto: CreateCollaboratorDto): Promise<UserWithoutPassword> {
    const existingUser = await this.userRepository.findOne({
      where: { email: createCollaboratorDto.email },
    });

    if (existingUser) {
      throw new ConflictException({
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
    
    // Remove password do resultado
    const { password, ...userWithoutPassword } = savedUser;
    return userWithoutPassword;
  }

  async findAll(query: QueryCollaboratorDto): Promise<PaginationResult<UserWithoutPassword>> {
    const { page = 1, limit = 20, search, role } = query;
    const skip = (page - 1) * limit;

    const queryBuilder = this.userRepository.createQueryBuilder('user');

    if (search) {
      queryBuilder.where(
        '(user.name LIKE :search OR user.email LIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (role) {
      queryBuilder.andWhere('user.role = :role', { role });
    }

    queryBuilder.skip(skip).take(limit).orderBy('user.createdAt', 'DESC');

    const [users, total] = await queryBuilder.getManyAndCount();

    // Remove password dos resultados
    const usersWithoutPassword = users.map(({ password, ...user }) => user);

    return paginate(usersWithoutPassword, total, { page, limit });
  }

  async findOne(id: string): Promise<UserWithoutPassword> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'COLLABORATOR_NOT_FOUND',
        message: 'Colaborador não encontrado',
      });
    }

    // Remove password do resultado
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  async update(
    id: string,
    updateCollaboratorDto: UpdateCollaboratorDto,
  ): Promise<UserWithoutPassword> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'COLLABORATOR_NOT_FOUND',
        message: 'Colaborador não encontrado',
      });
    }

    if (updateCollaboratorDto.email && updateCollaboratorDto.email !== user.email) {
      const existingUser = await this.userRepository.findOne({
        where: { email: updateCollaboratorDto.email },
      });

      if (existingUser) {
        throw new ConflictException({
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'Email já cadastrado',
        });
      }
    }

    Object.assign(user, updateCollaboratorDto);
    const updatedUser = await this.userRepository.save(user);
    
    // Remove password do resultado
    const { password, ...userWithoutPassword } = updatedUser;
    return userWithoutPassword;
  }

  async remove(id: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'COLLABORATOR_NOT_FOUND',
        message: 'Colaborador não encontrado',
      });
    }

    await this.userRepository.remove(user);
  }

  async updateAvatar(id: string, avatarUrl: string): Promise<UserWithoutPassword> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'COLLABORATOR_NOT_FOUND',
        message: 'Colaborador não encontrado',
      });
    }

    user.avatarUrl = avatarUrl;
    const updatedUser = await this.userRepository.save(user);
    
    // Remove password do resultado
    const { password, ...userWithoutPassword } = updatedUser;
    return userWithoutPassword;
  }
}
