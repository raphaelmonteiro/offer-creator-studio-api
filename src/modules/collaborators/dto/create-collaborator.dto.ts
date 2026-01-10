import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsEnum,
  MinLength,
} from 'class-validator';

export enum CollaboratorRole {
  COLLABORATOR = 'collaborator',
  MANAGER = 'manager',
  ADMIN = 'admin',
}

export enum CollaboratorStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export class CreateCollaboratorDto {
  @ApiProperty({ example: 'Carlos Santos' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'carlos@empresa.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '(11) 97777-7777', required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ enum: CollaboratorRole, default: CollaboratorRole.COLLABORATOR })
  @IsEnum(CollaboratorRole)
  role: CollaboratorRole;

  @ApiProperty({ example: 'senha123' })
  @IsString()
  @MinLength(6)
  password: string;
}
