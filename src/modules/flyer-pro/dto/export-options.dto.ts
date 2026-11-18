import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ExportOptions, ExportPreset, FLYER_PRO_EXPORT_PRESETS } from '../domain/flyer-pro.types';

/** O maior lado de uma folha em pixels (a 450 DPI, 54×40 cm com sangria dá 9567 px). */
const PIXELS_MAX = 16_384;

/** O encarte tem no máximo 4 folhas. */
const SHEETS_MAX = 4;

/**
 * As opções com que o arquivo foi gerado (`options` do N8). Só a forma (400); a coerência com o preset é do serviço
 * (422). `jpegQuality` é o único opcional: `null` vale como ausente (D-3) e o serviço o tira antes de gravar. Chave
 * desconhecida (`cropMarks`) é 400 pelo pipe global.
 */
export class ExportOptionsDto implements ExportOptions {
  @ApiProperty({ enum: FLYER_PRO_EXPORT_PRESETS })
  @IsIn(FLYER_PRO_EXPORT_PRESETS)
  preset: ExportPreset;

  @ApiProperty({ enum: [450, 72] })
  @IsIn([450, 72])
  dpi: 450 | 72;

  @ApiProperty({ enum: ['sheet'] })
  @IsIn(['sheet'])
  unit: 'sheet';

  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: SHEETS_MAX,
    description: 'As folhas exportadas, de 1 a 4, sem repetir; a ordem fica como veio',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHEETS_MAX)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(SHEETS_MAX, { each: true })
  sheets: number[];

  @ApiProperty({ enum: ['rgb'] })
  @IsIn(['rgb'])
  color: 'rgb';

  @ApiPropertyOptional({
    minimum: 0.5,
    maximum: 1,
    description: 'Só no PDF; nulo vale como ausente',
  })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(1)
  jpegQuality?: number;

  @ApiProperty({ minimum: 1, maximum: PIXELS_MAX })
  @IsInt()
  @Min(1)
  @Max(PIXELS_MAX)
  widthPx: number;

  @ApiProperty({ minimum: 1, maximum: PIXELS_MAX })
  @IsInt()
  @Min(1)
  @Max(PIXELS_MAX)
  heightPx: number;

  @ApiProperty()
  @IsBoolean()
  bleed: boolean;
}
