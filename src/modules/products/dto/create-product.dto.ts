import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  Min,
  IsUrl,
} from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: 'Arroz Tipo 1 5kg' })
  @IsString()
  name: string;

  @ApiProperty({ example: 24.9 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ example: 29.9, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  originalPrice?: number | null;

  @ApiProperty({ example: 'un' })
  @IsString()
  unit: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsUrl()
  imageUrl?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'Mercearia' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, nullable: true, example: 'MERC001' })
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  observation?: string | null;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
