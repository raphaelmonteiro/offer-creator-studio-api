import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsUrl, IsArray, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ClientContactDto } from './client-contact.dto';
import { ClientStoreDto } from './client-store.dto';

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

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  email?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  address?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  phoneFixed?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  phoneMobile?: string | null;

  // Rodapé "ativo" (legado) — TemplateSection opaca (validada no frontend, como configuration).
  @ApiProperty({ required: false, nullable: true, type: 'object' })
  @IsOptional()
  @IsObject()
  footer?: Record<string, unknown> | null;

  // Biblioteca de rodapés do cliente — array opaco de `{ id, name, section }`.
  @ApiProperty({ required: false, nullable: true, type: 'array' })
  @IsOptional()
  @IsArray()
  footers?: Record<string, unknown>[] | null;

  @ApiProperty({ type: [ClientContactDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClientContactDto)
  contacts?: ClientContactDto[];

  @ApiProperty({ type: [ClientStoreDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClientStoreDto)
  stores?: ClientStoreDto[];
}
