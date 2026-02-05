import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { User } from './entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { EmailService } from '../email/email.service';
export declare class AuthService {
    private userRepository;
    private jwtService;
    private configService;
    private emailService;
    constructor(userRepository: Repository<User>, jwtService: JwtService, configService: ConfigService, emailService: EmailService);
    validateUser(email: string, password: string): Promise<any>;
    validateUserById(id: string): Promise<User | null>;
    login(loginDto: LoginDto): Promise<{
        user: {
            id: any;
            name: any;
            email: any;
            emailVerified: any;
            role: any;
            createdAt: any;
        };
        token: string;
        refreshToken: string;
        expiresIn: number;
    }>;
    signup(signupDto: SignupDto): Promise<{
        user: {
            id: string;
            name: string;
            email: string;
            emailVerified: boolean;
            createdAt: Date;
        };
        message: string;
    }>;
    refreshToken(refreshToken: string): Promise<{
        token: string;
        expiresIn: number;
    }>;
    forgotPassword(email: string): Promise<{
        message: string;
    }>;
    resetPassword(token: string, password: string, confirmPassword?: string): Promise<{
        message: string;
    }>;
    verifyEmail(token: string): Promise<{
        message: string;
    }>;
    getProfile(userId: string): Promise<{
        id: string;
        name: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string;
        cpfCnpj: string;
        avatarUrl: string;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        };
        createdAt: Date;
        updatedAt: Date;
    }>;
    updateProfile(userId: string, updateProfileDto: UpdateProfileDto): Promise<{
        id: string;
        name: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string;
        cpfCnpj: string;
        avatarUrl: string;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        };
        createdAt: Date;
        updatedAt: Date;
    }>;
    updateAvatar(userId: string, avatarUrl: string): Promise<{
        id: string;
        name: string;
        email: string;
        emailVerified: boolean;
        role: string;
        phone: string;
        cpfCnpj: string;
        avatarUrl: string;
        establishment: {
            tradeName?: string;
            companyName?: string;
            address?: string;
            city?: string;
            state?: string;
            zipCode?: string;
        };
        createdAt: Date;
        updatedAt: Date;
    }>;
}
