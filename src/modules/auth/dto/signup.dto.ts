import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class SignupDto {
  @ApiProperty({ example: 'João Silva' })
  @IsString()
  @MinLength(3)
  name: string;

  @ApiProperty({ example: 'usuario@exemplo.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'senha123' })
  @IsString()
  @MinLength(6)
  password: string;

  @ApiProperty({ example: 'senha123' })
  @IsString()
  @MinLength(6)
  confirmPassword: string;
}
