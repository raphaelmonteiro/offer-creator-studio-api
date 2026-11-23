import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ExportFormat,
  FLYER_PRO_EXPORT_FORMATS,
  FlyerProExportEntry,
} from '../domain/flyer-pro.types';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { ExportOptionsDto } from './export-options.dto';
import { ExportPreflightDto } from './export-preflight.dto';

/** Minúsculas, sem espaço nem acento, começa por letra ou dígito e termina na extensão do formato. */
const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.(pdf|png|zip)$/;

/**
 * O corpo do N8 (registro de uma exportação já baixada): só a forma (400); a coerência com o preset, a extensão e a
 * revisão são do serviço (422). Sem arquivo e sem hora do download: `exportedAt`, `fileUrl`, `pageCount`, `filePath` e
 * `fileState` são campos desconhecidos, 400 pelo pipe global (D-2, PU-50). `fileSize` e `preflight` são opcionais, e
 * `null` vale como ausente (D-3): `@IsOptional()` só neles. `options` leva `@IsObject()` porque o `@ValidateNested()`
 * pula o `null` (L-24).
 */
export class CreateFlyerProExportDto implements FlyerProExportEntry {
  @ApiProperty({ description: 'Gerado no front; o mesmo id reenviado não grava de novo' })
  @IsUUID()
  id: string;

  @ApiProperty({ enum: FLYER_PRO_EXPORT_FORMATS })
  @IsIn(FLYER_PRO_EXPORT_FORMATS)
  format: ExportFormat;

  @ApiProperty({ type: ExportOptionsDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => ExportOptionsDto)
  options: ExportOptionsDto;

  @ApiProperty({ minimum: 0, description: 'A revisão do encarte que o arquivo mostra' })
  @IsInt()
  @Min(0)
  @Max(FLYER_PRO_LIMITS.versionMax)
  documentRevision: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  engineVersion: number;

  @ApiProperty({ minLength: 1, maxLength: FLYER_PRO_LIMITS.exportRenderDigestMaxLength })
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.exportRenderDigestMaxLength)
  renderDigest: string;

  @ApiProperty({
    minLength: FLYER_PRO_LIMITS.exportFileNameMinLength,
    maxLength: FLYER_PRO_LIMITS.exportFileNameMaxLength,
    pattern: FILE_NAME_PATTERN.source,
  })
  @IsString()
  @Length(FLYER_PRO_LIMITS.exportFileNameMinLength, FLYER_PRO_LIMITS.exportFileNameMaxLength)
  @Matches(FILE_NAME_PATTERN)
  fileName: string;

  @ApiPropertyOptional({ minimum: 1, description: 'Bytes do arquivo; nulo vale como ausente' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  fileSize?: number;

  @ApiPropertyOptional({
    type: ExportPreflightDto,
    description: 'Contagem dos alertas; nulo vale como ausente',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ExportPreflightDto)
  preflight?: ExportPreflightDto;
}
