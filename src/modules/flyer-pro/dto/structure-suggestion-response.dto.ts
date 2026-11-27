import { ApiProperty } from '@nestjs/swagger';
import { STRUCTURE_HERO_SIZES, type StructureHeroSize } from '../domain/structure-suggestion.types';

/** A resposta 200 da N19 na versão 2, só para o Swagger (a rota devolve o objeto simples da proposta saneada). */

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

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'Os itens da seção do pedido que são do encarte, na ordem proposta (ids reais); null mantém a ordem de hoje (ordem igual, lista que não confere, seção esquecida)',
  })
  itemIds: string[] | null;

  @ApiProperty({ description: 'Até 160 caracteres; vazio quando itemIds é null' })
  itemsReason: string;
}

export class SuggestedHeroDto {
  @ApiProperty()
  itemId: string;

  @ApiProperty({ enum: STRUCTURE_HERO_SIZES })
  size: StructureHeroSize;

  @ApiProperty()
  reason: string;
}

export class SuggestedUnsuggestDto {
  @ApiProperty({ description: 'Um item de suggestedHeroes do pedido (sugerido do motor)' })
  itemId: string;

  @ApiProperty({ description: 'Até 160 caracteres' })
  reason: string;
}

export class SuggestedCampaignDto {
  @ApiProperty({ enum: ['category', 'discount'] })
  kind: string;

  @ApiProperty({ description: 'Até 60 caracteres' })
  label: string;
}

export class DiscardedEntryDto {
  @ApiProperty({ enum: ['section', 'page', 'itemOrder', 'hero', 'unsuggest'] })
  kind: string;

  @ApiProperty({
    example: 'UNKNOWN_SECTION',
    description:
      'section: UNKNOWN_SECTION ou DUPLICATED; page: PAGE_OUT_OF_RANGE ou USER_PINNED; itemOrder: ITEMS_MISMATCH; hero: UNKNOWN_ITEM, DUPLICATED, HERO_WITHOUT_PHOTO, HERO_ALREADY_SET, HERO_USER_SET ou HERO_LIMIT; unsuggest: UNKNOWN_ITEM, DUPLICATED, NOT_SUGGESTED ou CONFLICTS_WITH_HERO',
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

  @ApiProperty({ example: 2 })
  promptVersion: number;

  @ApiProperty({
    description:
      'A proposta é igual ao estado enviado: nenhuma ordem de seções, página, destaque, ordem de produtos nem sugerido a desfazer; a campanha não conta',
  })
  noChange: boolean;

  @ApiProperty({ description: 'Até 300 caracteres' })
  summary: string;

  @ApiProperty({
    type: SuggestedCampaignDto,
    nullable: true,
    description: 'A campanha lida no nome do encarte, ou null (só informa; não muda nada)',
  })
  campaign: SuggestedCampaignDto | null;

  @ApiProperty({
    type: [SuggestedSectionDto],
    description: 'Todas as seções com faixa, na ordem proposta',
  })
  sections: SuggestedSectionDto[];

  @ApiProperty({
    type: [SuggestedHeroDto],
    description:
      'Só os destaques novos: nunca um item com destaque do usuário; o que o motor já mostra no mesmo tamanho pode vir',
  })
  heroes: SuggestedHeroDto[];

  @ApiProperty({
    type: [SuggestedUnsuggestDto],
    description: 'Os sugeridos do motor (de suggestedHeroes) que a IA propõe desfazer',
  })
  unsuggest: SuggestedUnsuggestDto[];

  @ApiProperty({ type: [DiscardedEntryDto], description: 'O que o saneamento tirou' })
  discarded: DiscardedEntryDto[];

  @ApiProperty({ type: StructureBasedOnDto })
  basedOn: StructureBasedOnDto;
}
