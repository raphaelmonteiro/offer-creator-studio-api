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
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const user_entity_1 = require("./entities/user.entity");
const email_service_1 = require("../email/email.service");
let AuthService = class AuthService {
    constructor(userRepository, jwtService, configService, emailService) {
        this.userRepository = userRepository;
        this.jwtService = jwtService;
        this.configService = configService;
        this.emailService = emailService;
    }
    async validateUser(email, password) {
        const user = await this.userRepository.findOne({ where: { email } });
        if (user && (await user.validatePassword(password))) {
            const { password: _, ...result } = user;
            return result;
        }
        return null;
    }
    async validateUserById(id) {
        return this.userRepository.findOne({ where: { id } });
    }
    async login(loginDto) {
        const user = await this.validateUser(loginDto.email, loginDto.password);
        if (!user) {
            throw new common_1.UnauthorizedException({
                code: 'INVALID_CREDENTIALS',
                message: 'Email ou senha inválidos',
            });
        }
        const payload = { email: user.email, sub: user.id };
        const token = this.jwtService.sign(payload);
        const refreshToken = this.jwtService.sign(payload, {
            secret: this.configService.get('JWT_REFRESH_SECRET'),
            expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN', '7d'),
        });
        return {
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                emailVerified: user.emailVerified,
                role: user.role,
                createdAt: user.createdAt,
            },
            token,
            refreshToken,
            expiresIn: this.configService.get('JWT_EXPIRES_IN', 3600),
        };
    }
    async signup(signupDto) {
        const existingUser = await this.userRepository.findOne({
            where: { email: signupDto.email },
        });
        if (existingUser) {
            throw new common_1.ConflictException({
                code: 'EMAIL_ALREADY_EXISTS',
                message: 'Email já cadastrado',
            });
        }
        if (signupDto.password !== signupDto.confirmPassword) {
            throw new common_1.ConflictException({
                code: 'PASSWORD_MISMATCH',
                message: 'As senhas não coincidem',
            });
        }
        const verificationToken = (0, crypto_1.randomBytes)(32).toString('hex');
        const verificationExpires = new Date();
        verificationExpires.setHours(verificationExpires.getHours() + 24);
        const user = this.userRepository.create({
            name: signupDto.name,
            email: signupDto.email,
            password: signupDto.password,
            emailVerified: false,
            role: 'user',
            emailVerificationToken: verificationToken,
            emailVerificationExpires: verificationExpires,
        });
        const savedUser = await this.userRepository.save(user);
        try {
            await this.emailService.sendEmailVerification(savedUser.email, savedUser.name, verificationToken);
        }
        catch (error) {
            console.error('Erro ao enviar email de verificação:', error);
        }
        const { password: _, ...userWithoutPassword } = savedUser;
        return {
            user: {
                id: userWithoutPassword.id,
                name: userWithoutPassword.name,
                email: userWithoutPassword.email,
                emailVerified: userWithoutPassword.emailVerified,
                createdAt: userWithoutPassword.createdAt,
            },
            message: 'Usuário criado. Verifique seu email para ativar a conta.',
        };
    }
    async refreshToken(refreshToken) {
        try {
            const payload = this.jwtService.verify(refreshToken, {
                secret: this.configService.get('JWT_REFRESH_SECRET'),
            });
            const user = await this.validateUserById(payload.sub);
            if (!user) {
                throw new common_1.UnauthorizedException();
            }
            const newPayload = { email: user.email, sub: user.id };
            const token = this.jwtService.sign(newPayload);
            return {
                token,
                expiresIn: this.configService.get('JWT_EXPIRES_IN', 3600),
            };
        }
        catch (error) {
            throw new common_1.UnauthorizedException({
                code: 'INVALID_REFRESH_TOKEN',
                message: 'Token de refresh inválido',
            });
        }
    }
    async forgotPassword(email) {
        const user = await this.userRepository.findOne({ where: { email } });
        if (!user) {
            return { message: 'Se o email estiver cadastrado, você receberá um link para redefinir sua senha.' };
        }
        const resetToken = (0, crypto_1.randomBytes)(32).toString('hex');
        const resetExpires = new Date();
        resetExpires.setHours(resetExpires.getHours() + 1);
        user.passwordResetToken = resetToken;
        user.passwordResetExpires = resetExpires;
        await this.userRepository.save(user);
        try {
            await this.emailService.sendPasswordReset(user.email, user.name, resetToken);
        }
        catch (error) {
            console.error('Erro ao enviar email de reset de senha:', error);
            user.passwordResetToken = null;
            user.passwordResetExpires = null;
            await this.userRepository.save(user);
            throw new common_1.BadRequestException({
                code: 'EMAIL_SEND_ERROR',
                message: 'Erro ao enviar email. Tente novamente mais tarde.',
            });
        }
        return { message: 'Se o email estiver cadastrado, você receberá um link para redefinir sua senha.' };
    }
    async resetPassword(token, password, confirmPassword) {
        if (confirmPassword && password !== confirmPassword) {
            throw new common_1.BadRequestException({
                code: 'PASSWORD_MISMATCH',
                message: 'As senhas não coincidem',
            });
        }
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: token },
        });
        if (!user) {
            throw new common_1.BadRequestException({
                code: 'INVALID_TOKEN',
                message: 'Token inválido ou expirado',
            });
        }
        if (!user.passwordResetExpires || user.passwordResetExpires < new Date()) {
            user.passwordResetToken = null;
            user.passwordResetExpires = null;
            await this.userRepository.save(user);
            throw new common_1.BadRequestException({
                code: 'TOKEN_EXPIRED',
                message: 'Token expirado. Solicite um novo link de redefinição de senha.',
            });
        }
        user.password = password;
        user.passwordResetToken = null;
        user.passwordResetExpires = null;
        await this.userRepository.save(user);
        return { message: 'Senha alterada com sucesso' };
    }
    async verifyEmail(token) {
        const user = await this.userRepository.findOne({
            where: { emailVerificationToken: token },
        });
        if (!user) {
            throw new common_1.BadRequestException({
                code: 'INVALID_TOKEN',
                message: 'Token de verificação inválido',
            });
        }
        if (!user.emailVerificationExpires || user.emailVerificationExpires < new Date()) {
            throw new common_1.BadRequestException({
                code: 'TOKEN_EXPIRED',
                message: 'Token de verificação expirado. Solicite um novo email de verificação.',
            });
        }
        user.emailVerified = true;
        user.emailVerificationToken = null;
        user.emailVerificationExpires = null;
        await this.userRepository.save(user);
        return { message: 'Email verificado com sucesso' };
    }
    async getProfile(userId) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'USER_NOT_FOUND',
                message: 'Usuário não encontrado',
            });
        }
        const { password: _, ...userWithoutPassword } = user;
        return {
            id: userWithoutPassword.id,
            name: userWithoutPassword.name,
            email: userWithoutPassword.email,
            emailVerified: userWithoutPassword.emailVerified,
            role: userWithoutPassword.role,
            phone: userWithoutPassword.phone,
            cpfCnpj: userWithoutPassword.cpfCnpj,
            avatarUrl: userWithoutPassword.avatarUrl,
            establishment: userWithoutPassword.establishment,
            createdAt: userWithoutPassword.createdAt,
            updatedAt: userWithoutPassword.updatedAt,
        };
    }
    async updateProfile(userId, updateProfileDto) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'USER_NOT_FOUND',
                message: 'Usuário não encontrado',
            });
        }
        if (updateProfileDto.name !== undefined) {
            user.name = updateProfileDto.name;
        }
        if (updateProfileDto.phone !== undefined) {
            user.phone = updateProfileDto.phone;
        }
        if (updateProfileDto.cpfCnpj !== undefined) {
            user.cpfCnpj = updateProfileDto.cpfCnpj;
        }
        if (updateProfileDto.avatarUrl !== undefined) {
            user.avatarUrl = updateProfileDto.avatarUrl;
        }
        if (updateProfileDto.establishment !== undefined) {
            user.establishment = {
                ...(user.establishment || {}),
                ...updateProfileDto.establishment,
            };
        }
        const updatedUser = await this.userRepository.save(user);
        const { password: _, ...userWithoutPassword } = updatedUser;
        return {
            id: userWithoutPassword.id,
            name: userWithoutPassword.name,
            email: userWithoutPassword.email,
            emailVerified: userWithoutPassword.emailVerified,
            role: userWithoutPassword.role,
            phone: userWithoutPassword.phone,
            cpfCnpj: userWithoutPassword.cpfCnpj,
            avatarUrl: userWithoutPassword.avatarUrl,
            establishment: userWithoutPassword.establishment,
            createdAt: userWithoutPassword.createdAt,
            updatedAt: userWithoutPassword.updatedAt,
        };
    }
    async updateAvatar(userId, avatarUrl) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) {
            throw new common_1.NotFoundException({
                code: 'USER_NOT_FOUND',
                message: 'Usuário não encontrado',
            });
        }
        user.avatarUrl = avatarUrl;
        const updatedUser = await this.userRepository.save(user);
        const { password: _, ...userWithoutPassword } = updatedUser;
        return {
            id: userWithoutPassword.id,
            name: userWithoutPassword.name,
            email: userWithoutPassword.email,
            emailVerified: userWithoutPassword.emailVerified,
            role: userWithoutPassword.role,
            phone: userWithoutPassword.phone,
            cpfCnpj: userWithoutPassword.cpfCnpj,
            avatarUrl: userWithoutPassword.avatarUrl,
            establishment: userWithoutPassword.establishment,
            createdAt: userWithoutPassword.createdAt,
            updatedAt: userWithoutPassword.updatedAt,
        };
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        jwt_1.JwtService,
        config_1.ConfigService,
        email_service_1.EmailService])
], AuthService);
//# sourceMappingURL=auth.service.js.map