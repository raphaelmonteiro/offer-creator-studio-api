import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SetImageEanDto {
  @ApiProperty({
    example: '7891000100103',
    description:
      'EAN/GTIN do produto que esta imagem representa (8, 12, 13 ou 14 dígitos; o dígito verificador é conferido).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  ean: string;

  @ApiPropertyOptional({
    example: 'DOCE DE LEITE CHANDELLE 350G',
    description: 'Nome do produto no encarte, só para o histórico do vínculo.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string;
}
