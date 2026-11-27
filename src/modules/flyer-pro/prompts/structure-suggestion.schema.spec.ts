import {
  STRUCTURE_SUGGESTION_SCHEMA,
  STRUCTURE_SUGGESTION_SCHEMA_NAME,
} from './structure-suggestion.schema';

describe('schema estrito da saída do modelo (versão 2)', () => {
  it('tem o nome flyer_pro_structure_suggestion e confere com o snapshot', () => {
    expect(STRUCTURE_SUGGESTION_SCHEMA_NAME).toBe('flyer_pro_structure_suggestion');
    expect(STRUCTURE_SUGGESTION_SCHEMA).toMatchSnapshot();
  });

  it('Schema no corpo: os cinco objetos são fechados e têm todos os campos obrigatórios', () => {
    const { campaign, sections, heroes, unsuggest } = STRUCTURE_SUGGESTION_SCHEMA.properties;
    const objects = [
      STRUCTURE_SUGGESTION_SCHEMA,
      campaign,
      sections.items,
      heroes.items,
      unsuggest.items,
    ];
    expect(objects).toHaveLength(5);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect([...object.required].sort()).toEqual(Object.keys(object.properties).sort());
    }
  });

  it('page é inteiro ou nulo, items é lista ou nulo, size é 2x1 ou 2x2 e kind é category, discount ou none', () => {
    const { campaign, sections, heroes } = STRUCTURE_SUGGESTION_SCHEMA.properties;
    expect(sections.items.properties.page.type).toEqual(['integer', 'null']);
    expect(sections.items.properties.items).toEqual({
      type: ['array', 'null'],
      items: { type: 'string' },
    });
    expect(heroes.items.properties.size.enum).toEqual(['2x1', '2x2']);
    expect(campaign.properties.kind.enum).toEqual(['category', 'discount', 'none']);
  });

  it('A sugestão não acrescenta página nem divide seção: o schema não tem campo para isso', () => {
    const { sections } = STRUCTURE_SUGGESTION_SCHEMA.properties;
    expect(Object.keys(STRUCTURE_SUGGESTION_SCHEMA.properties)).toEqual([
      'summary',
      'campaign',
      'sections',
      'heroes',
      'unsuggest',
    ]);
    expect(Object.keys(sections.items.properties)).toEqual([
      'id',
      'page',
      'reason',
      'items',
      'itemsReason',
    ]);
  });
});
