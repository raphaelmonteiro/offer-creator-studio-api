import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SpellCheckProductDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  id: string;

  @ApiProperty({ example: 'Arroz Tipo 1 Camil 5kg' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false, nullable: true, example: 'Produto fresquíssimo' })
  @IsOptional()
  @IsString()
  observation?: string | null;

  @ApiProperty({ required: false, nullable: true, example: 'OFERTA ESPECIAL' })
  @IsOptional()
  @IsString()
  badgeText?: string | null;
}

export class SpellCheckRequestDto {
  @ApiProperty({ type: [SpellCheckProductDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SpellCheckProductDto)
  products: SpellCheckProductDto[];
}
