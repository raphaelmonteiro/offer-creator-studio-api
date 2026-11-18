import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { EnrichStepsDto } from './enrich-steps.dto';
import { ValidateIfDefined } from './validate-if-defined.decorator';

/** O teto de itens do escopo de um job: o mesmo teto de itens do encarte. */
export const ENRICH_ITEM_IDS_MAX = 500;

/**
 * N14: só a forma (400). `steps` (de `EnrichStepsDto`) é obrigatório e `null` nele é 400. `itemIds` é o único campo cujo `null`
 * vale como ausente ("todos os itens"). `onlyMissing` e `autoApply` ausentes valem `true`, mas `null` é 400 e nunca
 * vale o padrão (A-28, L-24). O pipe global pula o corpo `{}`: o serviço o confere à mão.
 */
export class StartEnrichmentDto extends EnrichStepsDto {
  @ApiPropertyOptional({
    type: String,
    isArray: true,
    nullable: true,
    description: `Até ${ENRICH_ITEM_IDS_MAX} ids; ids de outro encarte são ignorados; null ou ausente vale todos`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ENRICH_ITEM_IDS_MAX)
  @IsUUID(undefined, { each: true })
  itemIds?: string[] | null;

  @ApiPropertyOptional({
    default: true,
    description: 'false refaz também o que a IA aplicou sozinha',
  })
  @ValidateIfDefined()
  @IsBoolean()
  onlyMissing?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'false: nada é aplicado sem clique, tudo vira sugestão',
  })
  @ValidateIfDefined()
  @IsBoolean()
  autoApply?: boolean;
}
