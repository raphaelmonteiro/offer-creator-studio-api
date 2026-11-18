import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  FlyerProImportEntry,
  IMPORT_FILE_KINDS,
  IMPORT_MODES,
  ImportFileKind,
  ImportMode,
} from '../domain/flyer-pro-import.types';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { FlyerProImportRejectedDto } from './flyer-pro-import-rejected.dto';

/**
 * O campo `import` do `PATCH` (N4): o registro da planilha importada. Só a forma (400); as contagens são do serviço
 * (422). Nada é aparado: nome do arquivo e trecho da linha ficam como vieram. `detectedFormat` é o único opcional (nulo
 * vale como ausente: a coluna aceita nulo).
 */
export class FlyerProImportDto implements FlyerProImportEntry {
  @ApiProperty({ description: 'Gerado no front; o mesmo id reenviado não grava de novo' })
  @IsUUID()
  id: string;

  @ApiProperty({ minLength: 1, maxLength: FLYER_PRO_LIMITS.importFileNameMaxLength })
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.importFileNameMaxLength)
  fileName: string;

  @ApiProperty({ enum: IMPORT_FILE_KINDS })
  @IsIn(IMPORT_FILE_KINDS)
  fileKind: ImportFileKind;

  @ApiProperty({ minLength: 1, maxLength: FLYER_PRO_LIMITS.importFileHashMaxLength })
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.importFileHashMaxLength)
  fileHash: string;

  @ApiPropertyOptional({ maxLength: FLYER_PRO_LIMITS.importDetectedFormatMaxLength })
  @IsOptional()
  @IsString()
  @MaxLength(FLYER_PRO_LIMITS.importDetectedFormatMaxLength)
  detectedFormat?: string;

  @ApiProperty({ enum: IMPORT_MODES })
  @IsIn(IMPORT_MODES)
  mode: ImportMode;

  @ApiProperty({ minimum: 0, description: 'Linhas de dados lidas' })
  @IsInt()
  @Min(0)
  @Max(FLYER_PRO_LIMITS.versionMax)
  rowCount: number;

  @ApiProperty({ minimum: 0, description: 'Linhas que viraram item' })
  @IsInt()
  @Min(0)
  @Max(FLYER_PRO_LIMITS.versionMax)
  acceptedCount: number;

  @ApiProperty({ type: [FlyerProImportRejectedDto], description: 'Até 200 linhas recusadas' })
  @IsArray()
  @ArrayMaxSize(FLYER_PRO_LIMITS.importRejectedMax)
  @ValidateNested({ each: true })
  @Type(() => FlyerProImportRejectedDto)
  rejected: FlyerProImportRejectedDto[];
}
