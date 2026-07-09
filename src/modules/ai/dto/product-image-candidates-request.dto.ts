import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
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
}
