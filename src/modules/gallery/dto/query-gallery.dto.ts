import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/** UUID ou o literal "none" (imagens sem nenhum cliente marcado). */
const UUID_OR_NONE =
  /^(none|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export class QueryGalleryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number = 20;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    required: false,
    description: '"none" = imagens sem pasta, omitido = todas',
  })
  @IsOptional()
  @IsString()
  folderId?: string;

  @ApiProperty({
    required: false,
    description:
      'Feature 13 — filtra pelas imagens marcadas para este cliente. "none" = imagens sem nenhum cliente. Omitido = todas.',
  })
  @IsOptional()
  @IsString()
  // Sem isso, um valor malformado chega ao Postgres como uuid inválido e vira
  // 500 em vez de 400 (o filtro compara com a coluna uuid client_id).
  @Matches(UUID_OR_NONE, { message: 'clientId deve ser um UUID ou "none".' })
  clientId?: string;
}
