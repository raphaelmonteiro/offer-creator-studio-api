import {
  STRUCTURE_CAMPAIGN_KINDS,
  STRUCTURE_HERO_SIZES,
} from '../domain/structure-suggestion.types';

/** O nome do `json_schema` da saída (`text.format` de `/responses`). */
export const STRUCTURE_SUGGESTION_SCHEMA_NAME = 'flyer_pro_structure_suggestion';

/**
 * O schema estrito da saída do modelo na versão 2 (anexo 11 § 3.4): objeto fechado com `summary`, `campaign` (`kind`,
 * `label`), `sections` (`id`, `page`, `reason`, `items`, `itemsReason`), `heroes` (`item`, `size`, `reason`) e
 * `unsuggest` (`item`, `reason`), todos os campos obrigatórios e nenhum a mais. Não há campo de número de páginas nem de
 * divisão de seção (decisão 4 do dono). Os ids que voltam são apelidos (`s1`, `p01`); o servidor os desfaz.
 */
export const STRUCTURE_SUGGESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'campaign', 'sections', 'heroes', 'unsuggest'],
  properties: {
    summary: { type: 'string' },
    campaign: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'label'],
      properties: {
        kind: { type: 'string', enum: [...STRUCTURE_CAMPAIGN_KINDS] },
        label: { type: 'string' },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'page', 'reason', 'items', 'itemsReason'],
        properties: {
          id: { type: 'string' },
          page: { type: ['integer', 'null'] },
          reason: { type: 'string' },
          items: { type: ['array', 'null'], items: { type: 'string' } },
          itemsReason: { type: 'string' },
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
    unsuggest: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'reason'],
        properties: {
          item: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;
