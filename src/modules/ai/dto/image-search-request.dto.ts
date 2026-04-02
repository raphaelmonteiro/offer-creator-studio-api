import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const PIXABAY_CATEGORIES = [
  'food', 'health', 'nature', 'animals',
  'industry', 'business', 'fashion', 'people',
] as const;

export type PixabayCategory = typeof PIXABAY_CATEGORIES[number];

export class ImageSearchRequestDto {
  @ApiProperty({ description: 'Nome original do produto (o backend normaliza o termo de busca)' })
  @IsString()
  @IsNotEmpty()
  rawName: string;

  @ApiProperty({ description: 'Categoria Pixabay para filtrar a busca', required: false, enum: PIXABAY_CATEGORIES })
  @IsOptional()
  @IsString()
  @IsIn(PIXABAY_CATEGORIES)
  category?: PixabayCategory;
}
