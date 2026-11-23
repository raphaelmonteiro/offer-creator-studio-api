import { ApiProperty } from '@nestjs/swagger';
import { STRUCTURE_HERO_SIZES, type StructureHeroSize } from '../domain/structure-suggestion.types';

/** A resposta 200 da N19, só para o Swagger (a rota devolve o objeto simples da proposta saneada). */

export class SuggestedSectionDto {
  @ApiProperty({ example: 'cat:Carnes' })
  id: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '1 a pageCount para fixar; null deixa o motor distribuir',
  })
  page: number | null;

  @ApiProperty({ description: 'Até 160 caracteres; vazio quando nada mudou' })
  reason: string;
}

export class SuggestedHeroDto {
  @ApiProperty()
  itemId: string;

  @ApiProperty({ enum: STRUCTURE_HERO_SIZES })
  size: StructureHeroSize;

  @ApiProperty()
  reason: string;
}

export class DiscardedEntryDto {
  @ApiProperty({ enum: ['section', 'page', 'hero'] })
  kind: string;

  @ApiProperty({
    example: 'UNKNOWN_SECTION',
    description:
      'UNKNOWN_SECTION, DUPLICATED, PAGE_OUT_OF_RANGE, USER_PINNED, UNKNOWN_ITEM, HERO_WITHOUT_PHOTO, HERO_ALREADY_SET ou HERO_LIMIT',
  })
  code: string;
}

export class StructureBasedOnDto {
  @ApiProperty({ description: 'Ids distintos do pedido que são itens do encarte' })
  items: number;

  @ApiProperty({ description: 'Seções com faixa do pedido' })
  sections: number;

  @ApiProperty({ description: 'Encartes anteriores do cliente usados como exemplo' })
  clientFlyers: number;
}

export class StructureSuggestionResponseDto {
  @ApiProperty({ description: 'UUID novo a cada pedido; vai para o log' })
  suggestionId: string;

  @ApiProperty({ description: 'Eco do pedido' })
  stateDigest: string;

  @ApiProperty({ enum: ['ai', 'mock'] })
  source: string;

  @ApiProperty({ example: 'gpt-6-luna' })
  model: string;

  @ApiProperty({ example: 1 })
  promptVersion: number;

  @ApiProperty({ description: 'A proposta é igual ao estado enviado' })
  noChange: boolean;

  @ApiProperty({ description: 'Até 300 caracteres' })
  summary: string;

  @ApiProperty({
    type: [SuggestedSectionDto],
    description: 'Todas as seções com faixa, na ordem proposta',
  })
  sections: SuggestedSectionDto[];

  @ApiProperty({ type: [SuggestedHeroDto], description: 'Só os destaques novos' })
  heroes: SuggestedHeroDto[];

  @ApiProperty({ type: [DiscardedEntryDto], description: 'O que o saneamento tirou' })
  discarded: DiscardedEntryDto[];

  @ApiProperty({ type: StructureBasedOnDto })
  basedOn: StructureBasedOnDto;
}
