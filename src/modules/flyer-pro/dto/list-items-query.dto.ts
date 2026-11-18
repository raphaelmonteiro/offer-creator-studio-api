import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

/** Só a forma estendida do ISO 8601 (data, hora e fuso opcionais), a que o Postgres lê sem ambiguidade. */
const EXTENDED_ISO =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;

/** N12: o cursor da abertura ou da leitura anterior; sem ele vêm todos os itens. */
export class ListFlyerProItemsQueryDto {
  @ApiPropertyOptional({
    description: 'ISO 8601, o `itemsCursor` da abertura ou o `cursor` da chamada anterior',
    example: '2026-11-14T13:05:40.412377Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(EXTENDED_ISO)
  updatedAfter?: string;
}
