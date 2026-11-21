import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, ArrayUnique, IsArray, IsIn } from 'class-validator';
import { ENRICH_PHASE_ORDER } from '../domain/flyer-pro-enrich-rules';
import type { EnrichStep } from '../domain/flyer-pro-job.types';

/**
 * As fases pedidas (`steps`), com as regras do N14: não vazia, sem repetição, só `categorize`, `spellcheck` e
 * `image_match`. É o corpo inteiro do campo `enrich` do `PATCH` (N4) e a base do pedido do N14. `null` em `steps` é 400
 * (não é lista), nunca vale ausente (A-28).
 */
export class EnrichStepsDto {
  @ApiProperty({
    enum: ENRICH_PHASE_ORDER,
    isArray: true,
    description: 'Fases pedidas; rodam sempre na ordem categorize, spellcheck, image_match',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsIn(ENRICH_PHASE_ORDER, { each: true })
  steps: EnrichStep[];
}
