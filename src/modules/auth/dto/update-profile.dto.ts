import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class EstablishmentDto {
  @ApiProperty({ required: false, example: 'Supermercado Bom Preço' })
  @IsOptional()
  @IsString()
  tradeName?: string;

  @ApiProperty({ required: false, example: 'Supermercado Bom Preço LTDA' })
  @IsOptional()
  @IsString()
  companyName?: string;

  @ApiProperty({ required: false, example: 'Rua das Flores, 123' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false, example: 'São Paulo' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false, example: 'SP' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ required: false, example: '01234-567' })
  @IsOptional()
  @IsString()
  zipCode?: string;
}

export class UpdateProfileDto {
  @ApiProperty({ required: false, example: 'João Silva' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, example: '(11) 99999-9999' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false, example: '123.456.789-00' })
  @IsOptional()
  @IsString()
  cpfCnpj?: string;

  @ApiProperty({ required: false, nullable: true, example: 'https://cdn.exemplo.com/avatars/user.jpg' })
  @IsOptional()
  @IsString()
  avatarUrl?: string | null;

  @ApiProperty({ type: EstablishmentDto, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => EstablishmentDto)
  establishment?: EstablishmentDto;
}
