import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { FlyerProFormat } from '../domain/flyer-pro.types';

export class ListFlyerProTemplatesQueryDto {
  @ApiPropertyOptional({ enum: ['27x40', '54x40'], description: 'Só as cenas desse formato' })
  @IsOptional()
  @IsIn(['27x40', '54x40'])
  format?: FlyerProFormat;

  @ApiPropertyOptional({
    maxLength: FLYER_PRO_LIMITS.searchMaxLength,
    description: 'Parte do nome da cena, sem diferenciar maiúsculas nem acentos',
  })
  @IsOptional()
  @IsString()
  @MaxLength(FLYER_PRO_LIMITS.searchMaxLength)
  search?: string;

  @ApiPropertyOptional({ description: 'Uma cena só, se ela cumprir as regras da lista' })
  @IsOptional()
  @IsUUID()
  sceneId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: FLYER_PRO_LIMITS.listDefaultLimit,
    minimum: 1,
    maximum: FLYER_PRO_LIMITS.listMaxLimit,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.listMaxLimit)
  limit?: number;
}
