import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { ValidateIfDefined } from './validate-if-defined.decorator';

/**
 * As cinco fatias do `PATCH`: objetos opacos, sem `@ValidateNested`; chave fora da lista é 400 pelo pipe global. Chave
 * ausente não muda a coluna; presente com `null`, lista ou texto é 400 (`@IsOptional` deixaria o `null` virar NULL na
 * coluna NOT NULL, e o Postgres devolveria 500).
 */
export class FlyerProSlicesPatchDto {
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIfDefined()
  @IsObject()
  frame?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIfDefined()
  @IsObject()
  structure?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIfDefined()
  @IsObject()
  card?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIfDefined()
  @IsObject()
  assembly?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @ValidateIfDefined()
  @IsObject()
  exportPrefs?: Record<string, unknown>;
}
