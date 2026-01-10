import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { User } from './entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (user && (await user.validatePassword(password))) {
      const { password: _, ...result } = user;
      return result;
    }
    return null;
  }

  async validateUserById(id: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { id } });
  }

  async login(loginDto: LoginDto) {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email ou senha inválidos',
      });
    }

    const payload = { email: user.email, sub: user.id };
    const token = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'),
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
      expiresIn: this.configService.get<number>('JWT_EXPIRES_IN', 3600),
    };
  }

  async signup(signupDto: SignupDto) {
    const existingUser = await this.userRepository.findOne({
      where: { email: signupDto.email },
    });

    if (existingUser) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'Email já cadastrado',
      });
    }

    if (signupDto.password !== signupDto.confirmPassword) {
      throw new ConflictException({
        code: 'PASSWORD_MISMATCH',
        message: 'As senhas não coincidem',
      });
    }

    // Gera token de verificação de email
    const verificationToken = randomBytes(32).toString('hex');
    const verificationExpires = new Date();
    verificationExpires.setHours(verificationExpires.getHours() + 24); // Expira em 24 horas

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
    
    // Envia email de verificação
    try {
      await this.emailService.sendEmailVerification(
        savedUser.email,
        savedUser.name,
        verificationToken,
      );
    } catch (error) {
      console.error('Erro ao enviar email de verificação:', error);
      // Não falha o cadastro se o email não for enviado
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

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      const user = await this.validateUserById(payload.sub);
      if (!user) {
        throw new UnauthorizedException();
      }

      const newPayload = { email: user.email, sub: user.id };
      const token = this.jwtService.sign(newPayload);

      return {
        token,
        expiresIn: this.configService.get<number>('JWT_EXPIRES_IN', 3600),
      };
    } catch (error) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Token de refresh inválido',
      });
    }
  }

  async forgotPassword(email: string) {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      // Don't reveal if email exists for security
      return { message: 'Se o email estiver cadastrado, você receberá um link para redefinir sua senha.' };
    }

    // Gera token de reset de senha
    const resetToken = randomBytes(32).toString('hex');
    const resetExpires = new Date();
    resetExpires.setHours(resetExpires.getHours() + 1); // Expira em 1 hora

    // Salva token no usuário
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = resetExpires;
    await this.userRepository.save(user);

    // Envia email de reset de senha
    try {
      await this.emailService.sendPasswordReset(
        user.email,
        user.name,
        resetToken,
      );
    } catch (error) {
      console.error('Erro ao enviar email de reset de senha:', error);
      // Limpa o token se o email não foi enviado
      user.passwordResetToken = null;
      user.passwordResetExpires = null;
      await this.userRepository.save(user);
      throw new BadRequestException({
        code: 'EMAIL_SEND_ERROR',
        message: 'Erro ao enviar email. Tente novamente mais tarde.',
      });
    }

    return { message: 'Se o email estiver cadastrado, você receberá um link para redefinir sua senha.' };
  }

  async resetPassword(token: string, password: string, confirmPassword?: string) {
    // Valida se as senhas coincidem
    if (confirmPassword && password !== confirmPassword) {
      throw new BadRequestException({
        code: 'PASSWORD_MISMATCH',
        message: 'As senhas não coincidem',
      });
    }

    const user = await this.userRepository.findOne({
      where: { passwordResetToken: token },
    });

    if (!user) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'Token inválido ou expirado',
      });
    }

    // Verifica se o token não expirou
    if (!user.passwordResetExpires || user.passwordResetExpires < new Date()) {
      // Limpa o token expirado
      user.passwordResetToken = null;
      user.passwordResetExpires = null;
      await this.userRepository.save(user);

      throw new BadRequestException({
        code: 'TOKEN_EXPIRED',
        message: 'Token expirado. Solicite um novo link de redefinição de senha.',
      });
    }

    // Atualiza a senha e limpa o token
    user.password = password;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await this.userRepository.save(user);

    return { message: 'Senha alterada com sucesso' };
  }

  async verifyEmail(token: string) {
    const user = await this.userRepository.findOne({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'Token de verificação inválido',
      });
    }

    // Verifica se o token não expirou
    if (!user.emailVerificationExpires || user.emailVerificationExpires < new Date()) {
      throw new BadRequestException({
        code: 'TOKEN_EXPIRED',
        message: 'Token de verificação expirado. Solicite um novo email de verificação.',
      });
    }

    // Verifica o email e limpa o token
    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await this.userRepository.save(user);

    return { message: 'Email verificado com sucesso' };
  }

  async getProfile(userId: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
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

  async updateProfile(userId: string, updateProfileDto: UpdateProfileDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'Usuário não encontrado',
      });
    }

    // Atualiza apenas os campos fornecidos
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
      // Merge com establishment existente se houver
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

  async updateAvatar(userId: string, avatarUrl: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
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
}
