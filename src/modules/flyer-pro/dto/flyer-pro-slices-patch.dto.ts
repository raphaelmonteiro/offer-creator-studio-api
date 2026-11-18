import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, ValidateIf } from 'class-validator';

/**
 * As cinco fatias do `PATCH`: objetos opacos, sem `@ValidateNested`; chave fora da lista é 400 pelo pipe global. Chave
 * ausente não muda a coluna; presente com `null`, lista ou texto é 400 (`@IsOptional` deixaria o `null` virar NULL na
 * coluna NOT NULL, e o Postgres devolveria 500).
 */
export class FlyerProSlicesPatchDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  frame?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  structure?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  card?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  assembly?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  exportPrefs?: Record<string, unknown>;
}
