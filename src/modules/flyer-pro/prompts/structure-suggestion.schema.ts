import { STRUCTURE_HERO_SIZES } from '../domain/structure-suggestion.types';

/** O nome do `json_schema` da saída (`text.format` de `/responses`). */
export const STRUCTURE_SUGGESTION_SCHEMA_NAME = 'flyer_pro_structure_suggestion';

/**
 * O schema estrito da saída do modelo (anexo 11 § 3.4): objeto fechado com `summary`, `sections` (`id`, `page`, `reason`)
 * e `heroes` (`item`, `size`, `reason`), todos os campos obrigatórios e nenhum a mais. Os ids que voltam são apelidos
 * (`s1`, `p01`); o servidor os desfaz.
 */
export const STRUCTURE_SUGGESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'sections', 'heroes'],
  properties: {
    summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'page', 'reason'],
        properties: {
          id: { type: 'string' },
          page: { type: ['integer', 'null'] },
          reason: { type: 'string' },
        },
      },
    },
    heroes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'size', 'reason'],
        properties: {
          item: { type: 'string' },
          size: { type: 'string', enum: [...STRUCTURE_HERO_SIZES] },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;
