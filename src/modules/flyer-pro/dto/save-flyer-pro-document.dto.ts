import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { FlyerProItemsPatchDto } from './flyer-pro-items-patch.dto';
import { FlyerProSetupPatchDto } from './flyer-pro-setup-patch.dto';
import { FlyerProSlicesPatchDto } from './flyer-pro-slices-patch.dto';

/**
 * N4: só a forma (400). Os quatro primeiros campos são obrigatórios, mas o pipe global pula o corpo `{}`: o serviço os
 * confere à mão. `import` e `enrich` não existem ainda (changes 19 e 28): são campos desconhecidos. Os tamanhos e as
 * regras de valor são do serviço (422).
 */
export class SaveFlyerProDocumentDto {
  @ApiProperty({ description: 'Um id por corpo; reenviar o mesmo corpo usa o mesmo id' })
  @IsUUID()
  mutationId: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({ minimum: 1, maximum: FLYER_PRO_LIMITS.versionMax })
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  schemaVersion: number;

  @ApiProperty({ minimum: 1, maximum: FLYER_PRO_LIMITS.versionMax })
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  engineVersion: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  layoutDigest?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  renderDigest?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Até 128 KB' })
  @IsOptional()
  @IsObject()
  layoutSnapshot?: Record<string, unknown>;

  @ApiPropertyOptional({ type: FlyerProSetupPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => FlyerProSetupPatchDto)
  setup?: FlyerProSetupPatchDto;

  @ApiPropertyOptional({ type: FlyerProSlicesPatchDto, description: 'Cada fatia até 256 KB' })
  @IsOptional()
  @ValidateNested()
  @Type(() => FlyerProSlicesPatchDto)
  slices?: FlyerProSlicesPatchDto;

  @ApiPropertyOptional({ type: FlyerProItemsPatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => FlyerProItemsPatchDto)
  items?: FlyerProItemsPatchDto;
}
