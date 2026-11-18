import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/** O `setup` do `PATCH` (N4): só os campos que mudaram. A conferência contra o formato é do serviço (422). */
export class FlyerProSetupPatchDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: FLYER_PRO_LIMITS.nameMaxLength })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.nameMaxLength)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Outra cena do Templates v2: remonta a cópia da arte' })
  @IsOptional()
  @IsUUID()
  sceneId?: string;

  @ApiPropertyOptional({ description: '`true` refaz a cópia da mesma cena ("Atualizar arte")' })
  @IsOptional()
  @IsBoolean()
  refreshTemplate?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  pageCount?: number;
}
