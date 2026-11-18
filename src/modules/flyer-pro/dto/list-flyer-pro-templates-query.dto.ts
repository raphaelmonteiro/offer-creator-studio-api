import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { FlyerProFormat } from '../domain/flyer-pro.types';
import { FlyerProPagedQueryDto } from './flyer-pro-paged-query.dto';

export class ListFlyerProTemplatesQueryDto extends FlyerProPagedQueryDto {
  @ApiPropertyOptional({ enum: ['27x40', '54x40'], description: 'Só as cenas desse formato' })
  @IsOptional()
  @IsIn(['27x40', '54x40'])
  format?: FlyerProFormat;

  @ApiPropertyOptional({ description: 'Uma cena só, se ela cumprir as regras da lista' })
  @IsOptional()
  @IsUUID()
  sceneId?: string;
}
