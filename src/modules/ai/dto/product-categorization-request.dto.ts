import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductCategorizationProductDto {
  @ApiProperty({ example: 'import-1' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ example: 'Arroz Tipo 1 Camil 5kg' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ nullable: true, example: 'Pacote promocional' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Mercearia' })
  @IsOptional()
  @IsString()
  currentCategory?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'un' })
  @IsOptional()
  @IsString()
  unit?: string | null;
}

export class ProductCategorizationRequestDto {
  @ApiProperty({ type: [ProductCategorizationProductDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ProductCategorizationProductDto)
  products: ProductCategorizationProductDto[];

  @ApiPropertyOptional({
    type: [String],
    example: ['Hortifruti', 'Bebidas', 'Mercearia', 'Sem categoria'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedCategories?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  preserveExistingCategories?: boolean;
}
