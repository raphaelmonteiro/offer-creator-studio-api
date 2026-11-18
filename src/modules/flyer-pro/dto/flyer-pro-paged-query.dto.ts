import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/** A página e a busca que as listas do módulo (templates e encartes) aceitam; cada lista acrescenta os seus filtros. */
export class FlyerProPagedQueryDto {
  @ApiPropertyOptional({
    maxLength: FLYER_PRO_LIMITS.searchMaxLength,
    description: 'Parte do nome, sem diferenciar maiúsculas nem acentos',
  })
  @IsOptional()
  @IsString()
  @MaxLength(FLYER_PRO_LIMITS.searchMaxLength)
  search?: string;

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
