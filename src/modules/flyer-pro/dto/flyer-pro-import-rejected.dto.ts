import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  FlyerProImportRejectedRow,
  IMPORT_REJECT_REASONS,
  ImportRejectReason,
} from '../domain/flyer-pro-import.types';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/** Uma linha recusada de `import.rejected` (N4): só a forma (400), gravada como veio. */
export class FlyerProImportRejectedDto implements FlyerProImportRejectedRow {
  @ApiProperty({ minimum: 1, description: 'A linha na planilha' })
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  row: number;

  @ApiProperty({ enum: IMPORT_REJECT_REASONS })
  @IsIn(IMPORT_REJECT_REASONS)
  reason: ImportRejectReason;

  @ApiProperty({ maxLength: FLYER_PRO_LIMITS.importRawMaxLength, description: 'O trecho da linha' })
  @IsString()
  @MaxLength(FLYER_PRO_LIMITS.importRawMaxLength)
  raw: string;
}
