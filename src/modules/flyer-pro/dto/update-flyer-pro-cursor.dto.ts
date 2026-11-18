import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { FLYER_PRO_STEPS } from '../domain/flyer-pro-steps';

/**
 * N5: a etapa atual e o estado de tela. O pipe global pula o corpo `{}`, então o serviço confere `step` à mão (400, nunca
 * 500 por `step` nulo); o tamanho do `ui` é do serviço (422).
 */
export class UpdateFlyerProCursorDto {
  @ApiProperty({ enum: FLYER_PRO_STEPS })
  @IsIn([...FLYER_PRO_STEPS])
  step: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Estado de tela, até 16 KB; ausente ou nulo mantém o atual',
  })
  @IsOptional()
  @IsObject()
  ui?: Record<string, unknown>;
}
