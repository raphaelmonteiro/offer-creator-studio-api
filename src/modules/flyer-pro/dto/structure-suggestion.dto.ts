import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import {
  STRUCTURE_HERO_SIZES,
  type StructureHeroInput,
  type StructureHeroSize,
  type StructurePageInput,
  type StructureRequest,
  type StructureSectionInput,
  type StructureSuggestedHeroInput,
} from '../domain/structure-suggestion.types';
import { ValidateIfDefined } from './validate-if-defined.decorator';

const LIMITS = FLYER_PRO_LIMITS;

/** `cat:<1 a 40 caracteres>` ou `loose`; a conferência da categoria contra as 11 do módulo é do serviço (422). */
const SECTION_ID = new RegExp(`^(cat:.{1,${LIMITS.structureCategoryMaxLength}}|loose)$`);

export class StructurePageDto implements StructurePageInput {
  @ApiProperty({ minimum: 1, maximum: LIMITS.structurePageMax })
  @IsInt()
  @Min(1)
  @Max(LIMITS.structurePageMax)
  page: number;

  @ApiProperty({ minimum: 0, maximum: LIMITS.structureCellsMax })
  @IsInt()
  @Min(0)
  @Max(LIMITS.structureCellsMax)
  capacityCells: number;

  @ApiProperty({ minimum: 0, maximum: LIMITS.structureCellsMax })
  @IsInt()
  @Min(0)
  @Max(LIMITS.structureCellsMax)
  usedCells: number;

  @ApiProperty()
  @IsBoolean()
  header: boolean;

  @ApiProperty()
  @IsBoolean()
  footer: boolean;
}

export class StructureSectionDto implements StructureSectionInput {
  @ApiProperty({ example: 'cat:Carnes', description: '`cat:<categoria>` ou `loose`' })
  @IsString()
  @Matches(SECTION_ID)
  id: string;

  @ApiProperty({ type: [String], description: 'Ids de item; o que não é do encarte é ignorado' })
  @IsArray()
  @ArrayMaxSize(LIMITS.itemMax)
  @IsUUID(undefined, { each: true })
  itemIds: string[];

  @ApiProperty({ minimum: 0, maximum: LIMITS.structureCellsMax })
  @IsInt()
  @Min(0)
  @Max(LIMITS.structureCellsMax)
  cells: number;

  @ApiProperty({
    type: [Number],
    description: 'Páginas em que a seção está hoje (vazio: sem página)',
  })
  @IsArray()
  @ArrayMaxSize(LIMITS.structurePageMax)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(LIMITS.structurePageMax, { each: true })
  pages: number[];

  @ApiPropertyOptional({ minimum: 1, maximum: LIMITS.structurePageMax })
  @ValidateIfDefined()
  @IsInt()
  @Min(1)
  @Max(LIMITS.structurePageMax)
  pinnedPage?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: LIMITS.structureQuotaMax })
  @ValidateIfDefined()
  @IsInt()
  @Min(0)
  @Max(LIMITS.structureQuotaMax)
  quota?: number;
}

export class StructureHeroDto implements StructureHeroInput {
  @ApiProperty()
  @IsUUID()
  itemId: string;

  @ApiProperty({ enum: STRUCTURE_HERO_SIZES })
  @IsIn([...STRUCTURE_HERO_SIZES])
  size: StructureHeroSize;
}

export class StructureSuggestedHeroDto implements StructureSuggestedHeroInput {
  @ApiProperty()
  @IsUUID()
  itemId: string;

  @ApiProperty({ enum: STRUCTURE_HERO_SIZES })
  @IsIn([...STRUCTURE_HERO_SIZES])
  size: StructureHeroSize;

  @ApiProperty({ minimum: 1, maximum: LIMITS.structurePageMax, description: 'Página do card' })
  @IsInt()
  @Min(1)
  @Max(LIMITS.structurePageMax)
  page: number;
}

/**
 * O retrato da Estrutura que a tela envia para pedir a sugestão (N19). Só a forma (400): a coerência é do serviço (422) e
 * o corpo `{}`, que o pipe global pula, também. `unplaced`, `pinnedPage`, `quota` e `suggestedHeroes` ausentes valem o padrão;
 * `null` é 400.
 */
export class StructureSuggestionDto implements StructureRequest {
  @ApiProperty({ description: 'Opaco para o servidor; volta igual na resposta' })
  @IsString()
  @Length(1, LIMITS.structureDigestMaxLength)
  stateDigest: string;

  @ApiProperty({ minimum: 1, maximum: LIMITS.structurePageMax })
  @IsInt()
  @Min(1)
  @Max(LIMITS.structurePageMax)
  pageCount: number;

  @ApiProperty({ enum: [1, 2, 3], description: 'Nível dos cards (1 folgado, 3 denso)' })
  @IsIn([1, 2, 3])
  level: 1 | 2 | 3;

  @ApiPropertyOptional({ minimum: 0, maximum: LIMITS.itemMax, default: 0 })
  @ValidateIfDefined()
  @IsInt()
  @Min(0)
  @Max(LIMITS.itemMax)
  unplaced?: number;

  @ApiProperty({ type: [StructurePageDto], description: 'As páginas 1 a pageCount, uma vez cada' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LIMITS.structurePageMax)
  @ValidateNested({ each: true })
  @Type(() => StructurePageDto)
  pages: StructurePageDto[];

  @ApiProperty({
    type: [StructureSectionDto],
    description: 'Na ordem da tela; `loose`, se vier, é o último',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LIMITS.structureSectionMax)
  @ValidateNested({ each: true })
  @Type(() => StructureSectionDto)
  sections: StructureSectionDto[];

  @ApiProperty({ type: [StructureHeroDto], description: 'Destaques que o usuário já tem' })
  @IsArray()
  @ArrayMaxSize(LIMITS.itemMax)
  @ValidateNested({ each: true })
  @Type(() => StructureHeroDto)
  heroes: StructureHeroDto[];

  @ApiPropertyOptional({
    type: [StructureSuggestedHeroDto],
    default: [],
    description:
      'Os cards que a folha mostra como destaque sugerido pelo motor; a IA pode propor desfazê-los (padrão: nenhum)',
  })
  @ValidateIfDefined()
  @IsArray()
  @ArrayMaxSize(LIMITS.itemMax)
  @ValidateNested({ each: true })
  @Type(() => StructureSuggestedHeroDto)
  suggestedHeroes?: StructureSuggestedHeroDto[];
}
