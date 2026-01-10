import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsUrl, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ClientContactDto } from './client-contact.dto';

export class CreateClientDto {
  @ApiProperty({ example: 'Supermercado Bom Preço' })
  @IsString()
  name: string;

  @ApiProperty({ example: '12.345.678/0001-90' })
  @IsString()
  cnpj: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUrl()
  logoUrl?: string | null;

  @ApiProperty({ type: [ClientContactDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClientContactDto)
  contacts?: ClientContactDto[];
}
