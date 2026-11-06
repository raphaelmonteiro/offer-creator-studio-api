import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
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
