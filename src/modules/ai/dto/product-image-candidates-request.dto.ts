import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ProductImageCandidatesRequestDto {
  @ApiProperty({ example: 'Arroz Camil 5kg' })
  @IsString()
  @IsNotEmpty()
  productName: string;

  @ApiPropertyOptional({ nullable: true, example: 'Mercearia' })
  @IsOptional()
  @IsString()
  category?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'un' })
  @IsOptional()
  @IsString()
  unit?: string | null;

  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 48 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  limit?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Cliente do encarte em edição. Quando presente, prioriza as imagens preferidas deste cliente (Feature 12).',
    example: '3f2a...-uuid',
  })
  @IsOptional()
  @IsString()
  clientId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 32,
    description:
      'EAN do item (Encarte Pro). Presente (mesmo null, vazio ou com dígito errado): as fotos já escolhidas para o nome vêm fixadas no topo; com GTIN válido, as fotos com esse EAN vêm antes delas. Ausente: a resposta é a de sempre.',
    example: '7896000000019',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  ean?: string | null;
}
