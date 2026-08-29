import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  IsNumber,
} from 'class-validator';
import { MASCOT_ENTRANCES, MASCOT_GESTURES } from '../domain/presence-animation';

/** PATCH /v1/mascots/:id — renomear e (re)vincular a um cliente. */
export class UpdateMascotDto {
  @IsOptional()
  @IsString()
  @Length(2, 120, { message: 'O nome do mascote deve ter entre 2 e 120 caracteres.' })
  name?: string;

  @IsOptional()
  @IsUUID('4', { message: 'clientId inválido.' })
  clientId?: string | null;
}

/**
 * POST /v1/mascots/:id/rights — aceite de titularidade/licença da marca.
 * Requisito legal (spike risco 4): sem isto o mascote nunca fica `ready`.
 */
export class ConfirmMascotRightsDto {
  @IsIn([true, 'true', '1', 1], {
    message: 'É preciso declarar a titularidade ou licença de uso da marca do mascote.',
  })
  accepted: boolean | string | number;

  @IsOptional()
  @IsString()
  @Length(0, 240)
  note?: string;
}

export class QueryMascotsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsUUID('4')
  clientId?: string;

  @IsOptional()
  @IsIn(['draft', 'segmenting', 'needs_review', 'ready', 'failed'])
  status?: string;

  /** Por padrão a lista esconde arquivados. */
  @IsOptional()
  @IsIn(['true', 'false'])
  includeArchived?: string;
}

/** GET /v1/mascots/:id/preview — timeline de presença para o editor. */
export class MascotPreviewQueryDto {
  @IsOptional()
  @IsIn(MASCOT_GESTURES as unknown as string[], {
    message: `gesture deve ser um de: ${MASCOT_GESTURES.join(', ')}.`,
  })
  gesture?: string;

  @IsOptional()
  @IsIn(MASCOT_ENTRANCES as unknown as string[], {
    message: `entrance deve ser um de: ${MASCOT_ENTRANCES.join(', ')}.`,
  })
  entrance?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(30000)
  durationMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  intensity?: number;
}
