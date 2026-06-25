import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Min, IsIn } from 'class-validator';

export class QueryFlyerBuilderV2DocumentDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @Min(1)
  limit?: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /**
   * Filtra por tipo de documento (lê `document->>'documentKind'` no JSONB).
   * Valores aceitos: 'flyer' (encarte tradicional) ou 'social' (arte social).
   * Omita para retornar todos.
   */
  @ApiPropertyOptional({ enum: ['flyer', 'social'] })
  @IsOptional()
  @IsString()
  @IsIn(['flyer', 'social'])
  kind?: string;
}
