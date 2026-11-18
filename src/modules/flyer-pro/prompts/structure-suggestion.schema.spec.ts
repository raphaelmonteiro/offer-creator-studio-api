import {
  STRUCTURE_SUGGESTION_SCHEMA,
  STRUCTURE_SUGGESTION_SCHEMA_NAME,
} from './structure-suggestion.schema';

describe('schema estrito da saída do modelo', () => {
  it('tem o nome flyer_pro_structure_suggestion e confere com o snapshot', () => {
    expect(STRUCTURE_SUGGESTION_SCHEMA_NAME).toBe('flyer_pro_structure_suggestion');
    expect(STRUCTURE_SUGGESTION_SCHEMA).toMatchSnapshot();
  });

  it('os três objetos são fechados e têm todos os campos obrigatórios', () => {
    const { sections, heroes } = STRUCTURE_SUGGESTION_SCHEMA.properties;
    const objects = [STRUCTURE_SUGGESTION_SCHEMA, sections.items, heroes.items];
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect([...object.required].sort()).toEqual(Object.keys(object.properties).sort());
    }
  });

  it('page é inteiro ou nulo e size é 2x1 ou 2x2', () => {
    const { sections, heroes } = STRUCTURE_SUGGESTION_SCHEMA.properties;
    expect(sections.items.properties.page.type).toEqual(['integer', 'null']);
    expect(heroes.items.properties.size.enum).toEqual(['2x1', '2x2']);
  });
});
