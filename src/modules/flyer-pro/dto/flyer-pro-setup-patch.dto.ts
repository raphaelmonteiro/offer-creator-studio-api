import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { ValidateIfDefined } from './validate-if-defined.decorator';

/**
 * O `setup` do `PATCH` (N4): só os campos que mudaram. Campo ausente não muda; `null` é 400 (nenhum campo tem "sem
 * valor"). A conferência contra o formato é do serviço (422).
 */
export class FlyerProSetupPatchDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: FLYER_PRO_LIMITS.nameMaxLength })
  @ValidateIfDefined()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.nameMaxLength)
  name?: string;

  @ApiPropertyOptional()
  @ValidateIfDefined()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Outra cena do Templates v2: remonta a cópia da arte' })
  @ValidateIfDefined()
  @IsUUID()
  sceneId?: string;

  @ApiPropertyOptional({ description: '`true` refaz a cópia da mesma cena ("Atualizar arte")' })
  @ValidateIfDefined()
  @IsBoolean()
  refreshTemplate?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 4 })
  @ValidateIfDefined()
  @IsInt()
  @Min(1)
  @Max(4)
  pageCount?: number;
}
