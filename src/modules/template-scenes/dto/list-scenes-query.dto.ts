import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { FACE_KEYS, FaceKey } from '../domain/scene-faces';
import { SCENE_LIMITS } from '../domain/scene.types';

export class ListScenesQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: SCENE_LIMITS.listDefaultLimit,
    maximum: SCENE_LIMITS.listMaxLimit,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SCENE_LIMITS.listMaxLimit)
  limit?: number;
}

export class GetSceneQueryDto {
  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    description: 'Página das versões (mais recentes primeiro)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  versionsPage?: number;

  @ApiPropertyOptional({
    enum: FACE_KEYS,
    description:
      'Face de onde vem a página de versões; sem ela, a face 0. `currentVersion` e `zones` do topo seguem os da face 0',
  })
  @IsOptional()
  @IsIn(FACE_KEYS)
  face?: FaceKey;
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Id da mensagem mais antiga que a tela já tem (cursor)' })
  @IsOptional()
  @IsUUID()
  before?: string;

  @ApiPropertyOptional({
    default: SCENE_LIMITS.recentMessages,
    minimum: 1,
    maximum: SCENE_LIMITS.recentMessages,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SCENE_LIMITS.recentMessages)
  limit?: number;
}
