import { CollaboratorsService } from './collaborators.service';
import { CreateCollaboratorDto } from './dto/create-collaborator.dto';
import { UpdateCollaboratorDto } from './dto/update-collaborator.dto';
import { QueryCollaboratorDto } from './dto/query-collaborator.dto';
import { UploadsService } from '../uploads/uploads.service';
export declare class CollaboratorsController {
    private readonly collaboratorsService;
    private readonly uploadsService;
    constructor(collaboratorsService: CollaboratorsService, uploadsService: UploadsService);
    create(createCollaboratorDto: CreateCollaboratorDto): Promise<{
        name: string;
        id: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string | null;
        cpfCnpj: string | null;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        } | null;
        avatarUrl: string | null;
        emailVerificationToken: string | null;
        emailVerificationExpires: Date | null;
        passwordResetToken: string | null;
        passwordResetExpires: Date | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
    findAll(query: QueryCollaboratorDto): Promise<import("../../common/utils/pagination.util").PaginationResult<{
        name: string;
        id: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string | null;
        cpfCnpj: string | null;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        } | null;
        avatarUrl: string | null;
        emailVerificationToken: string | null;
        emailVerificationExpires: Date | null;
        passwordResetToken: string | null;
        passwordResetExpires: Date | null;
        createdAt: Date;
        updatedAt: Date;
    }>>;
    findOne(id: string): Promise<{
        name: string;
        id: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string | null;
        cpfCnpj: string | null;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        } | null;
        avatarUrl: string | null;
        emailVerificationToken: string | null;
        emailVerificationExpires: Date | null;
        passwordResetToken: string | null;
        passwordResetExpires: Date | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
    update(id: string, updateCollaboratorDto: UpdateCollaboratorDto): Promise<{
        name: string;
        id: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string | null;
        cpfCnpj: string | null;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        } | null;
        avatarUrl: string | null;
        emailVerificationToken: string | null;
        emailVerificationExpires: Date | null;
        passwordResetToken: string | null;
        passwordResetExpires: Date | null;
        createdAt: Date;
        updatedAt: Date;
    }>;
    remove(id: string): Promise<{
        message: string;
    }>;
    uploadAvatar(id: string, file: Express.Multer.File): Promise<{
        avatarUrl: string;
    }>;
}
