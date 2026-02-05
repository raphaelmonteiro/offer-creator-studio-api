import { Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { CreateCollaboratorDto } from './dto/create-collaborator.dto';
import { UpdateCollaboratorDto } from './dto/update-collaborator.dto';
import { QueryCollaboratorDto } from './dto/query-collaborator.dto';
import { PaginationResult } from '../../common/utils/pagination.util';
type UserWithoutPassword = Omit<User, 'password' | 'hashPassword' | 'hashPasswordIfChanged' | 'validatePassword'>;
export declare class CollaboratorsService {
    private userRepository;
    constructor(userRepository: Repository<User>);
    create(createCollaboratorDto: CreateCollaboratorDto): Promise<UserWithoutPassword>;
    findAll(query: QueryCollaboratorDto): Promise<PaginationResult<UserWithoutPassword>>;
    findOne(id: string): Promise<UserWithoutPassword>;
    update(id: string, updateCollaboratorDto: UpdateCollaboratorDto): Promise<UserWithoutPassword>;
    remove(id: string): Promise<void>;
    updateAvatar(id: string, avatarUrl: string): Promise<UserWithoutPassword>;
}
export {};
