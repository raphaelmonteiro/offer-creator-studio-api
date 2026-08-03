import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductImageMatchProductDto {
  @ApiProperty({ example: 'import-1' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ example: 'Arroz Camil 5kg' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ nullable: true, example: 'Mercearia' })
  @IsOptional()
  @IsString()
  category?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'un' })
  @IsOptional()
  @IsString()
  unit?: string | null;
}

export class ProductImageMatchRequestDto {
  @ApiProperty({ type: [ProductImageMatchProductDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProductImageMatchProductDto)
  products: ProductImageMatchProductDto[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Cliente do encarte em edição. Quando presente, prioriza as imagens preferidas deste cliente (Feature 12).',
    example: '3f2a...-uuid',
  })
  @IsOptional()
  @IsString()
  clientId?: string | null;
}
