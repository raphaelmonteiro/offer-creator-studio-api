import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UploadsService } from '../uploads/uploads.service';
export declare class AuthController {
    private readonly authService;
    private readonly uploadsService;
    constructor(authService: AuthService, uploadsService: UploadsService);
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
    refresh(refreshTokenDto: RefreshTokenDto): Promise<{
        token: string;
        expiresIn: number;
    }>;
    forgotPassword(forgotPasswordDto: ForgotPasswordDto): Promise<{
        message: string;
    }>;
    resetPassword(resetPasswordDto: ResetPasswordDto): Promise<{
        message: string;
    }>;
    verifyEmail(token: string): Promise<{
        message: string;
    }>;
    getProfile(user: any): Promise<{
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
    updateProfile(user: any, updateProfileDto: UpdateProfileDto): Promise<{
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
    uploadAvatar(user: any, file: Express.Multer.File): Promise<{
        avatarUrl: string;
    }>;
}
