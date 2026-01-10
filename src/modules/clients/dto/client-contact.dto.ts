import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsUUID } from 'class-validator';

export class ClientContactDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ example: 'Maria Silva' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Gerente de Marketing' })
  @IsString()
  role: string;

  @ApiProperty({ example: 'maria@bompreco.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '(11) 99999-9999' })
  @IsString()
  phone: string;
}
