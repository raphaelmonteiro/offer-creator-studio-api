import {
  StructureSuggestionResponseDto,
  SuggestedCampaignDto,
  SuggestedSectionDto,
  SuggestedUnsuggestDto,
} from './structure-suggestion-response.dto';

/** Os campos que o Swagger documenta de uma classe (`@ApiProperty`, guardados como `:campo` nos metadados). */
const documented = (target: { prototype: object }): string[] =>
  (Reflect.getMetadata('swagger/apiModelPropertiesArray', target.prototype) as string[])
    .map((name) => name.replace(/^:/, ''))
    .sort();

describe('StructureSuggestionResponseDto: o Swagger da resposta da versão 2', () => {
  it('a resposta documenta a campanha e os sugeridos a desfazer, além dos campos da versão 1', () => {
    expect(documented(StructureSuggestionResponseDto)).toEqual(
      [
        'basedOn',
        'campaign',
        'discarded',
        'heroes',
        'model',
        'noChange',
        'promptVersion',
        'sections',
        'source',
        'stateDigest',
        'suggestionId',
        'summary',
        'unsuggest',
      ].sort(),
    );
  });

  it('cada seção documenta a ordem dos produtos e o motivo dela', () => {
    expect(documented(SuggestedSectionDto)).toEqual(
      ['id', 'itemIds', 'itemsReason', 'page', 'reason'].sort(),
    );
  });

  it('o sugerido a desfazer e a campanha têm os campos do contrato', () => {
    expect(documented(SuggestedUnsuggestDto)).toEqual(['itemId', 'reason']);
    expect(documented(SuggestedCampaignDto)).toEqual(['kind', 'label']);
  });
});
