import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FACE_KEYS, FaceKey } from '../domain/scene-faces';
import { SCENE_ELEMENT_KINDS, SCENE_LIMITS, SceneElementKind } from '../domain/scene.types';

/** Camada manual. Imagem só por `assetId`: a API nunca aceita URL (`src`, `imageUrl` dão 400). */
export class SceneElementDto {
  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id: string;

  @ApiProperty({ enum: SCENE_ELEMENT_KINDS })
  @IsIn(SCENE_ELEMENT_KINDS)
  kind: SceneElementKind;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'Centro X, fração da largura' })
  @IsNumber()
  x: number;

  @ApiProperty({ description: 'Centro Y, fração da altura' })
  @IsNumber()
  y: number;

  @ApiProperty({ description: 'Largura, fração da largura da página' })
  @IsNumber()
  w: number;

  @ApiProperty({ description: 'Largura / altura em pixels' })
  @IsNumber()
  aspect: number;

  @ApiProperty()
  @IsNumber()
  rotation: number;

  @ApiProperty()
  @IsNumber()
  z: number;

  @ApiPropertyOptional({ description: 'Asset da própria cena (logo por upload)' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  glow?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  face?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  text?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  fontFamily?: string;

  @ApiPropertyOptional({ description: '% da largura da página' })
  @IsOptional()
  @IsNumber()
  fontSize?: number;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}

export class PatchElementsDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({ type: [SceneElementDto], maxItems: SCENE_LIMITS.maxElements })
  @IsArray()
  @ArrayMaxSize(SCENE_LIMITS.maxElements)
  @ValidateNested({ each: true })
  @Type(() => SceneElementDto)
  elements: SceneElementDto[];

  @ApiPropertyOptional({
    enum: FACE_KEYS,
    description:
      'Face das camadas; sem ela, a face 0. Face que a cena não tem: 422 `FACE_NOT_FOUND`',
  })
  @IsOptional()
  @IsIn(FACE_KEYS)
  face?: FaceKey;
}
