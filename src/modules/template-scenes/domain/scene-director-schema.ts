import { z } from 'zod';
import {
  LAYER_OBJECT_JSON_SCHEMA,
  LAYER_ZONES,
  layerIntentSchema,
  nullableString,
  TEXT_OBJECT_JSON_SCHEMA,
  textIntentSchema,
} from './scene-layer.types';

/**
 * Schema fechado do Diretor (`gpt-6-luna`): um plano curto por turno. O efeito vem de `turn_kind` e
 * `will_change_image` por tabela do código, nunca de texto livre. Campos de auditoria (`what_i_see`) e de
 * montagem do prompt (`what_to_change`, `what_to_put`, `inventory_keep`) nunca vão ao cliente.
 */

export const TURN_KINDS = [
  'pedido_item',
  'pedido_ajuste_geral',
  'pedido_composicao',
  'imagem_nova',
  'reclamacao',
  'pergunta',
  'marcacao_sem_pedido',
  'agradecimento',
  'desfazer',
  'camada',
  'recusa_pintado',
  'outro',
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export const REFUSALS = ['painted_text', 'painted_price', 'painted_logo'] as const;
export type PaintedRefusal = (typeof REFUSALS)[number];

export const LAYER_OPS = ['move', 'resize', 'remove', 'set_text', 'add_logo'] as const;
const LOGO_SIDES = ['left', 'center', 'right'] as const;
const REQUEST_ACTIONS = ['open', 'drop'] as const;

/** Limites do schema (caracteres, itens). */
export const DIRECTOR_LIMITS = {
  reply: 260,
  field: 400,
  seen: 500,
  keepItems: 8,
  keepName: 60,
  layerOps: 6,
  requests: 8,
  requestText: 200,
  quote: 200,
} as const;

const layerOpSchema = z
  .object({
    op: z.enum(LAYER_OPS),
    layer: layerIntentSchema.nullable(),
    text: textIntentSchema.nullable(),
    position: z
      .object({ side: z.enum(LOGO_SIDES), zone: z.enum(LAYER_ZONES) })
      .strict()
      .nullable(),
    replace: z.boolean(),
  })
  .strict();

const requestSchema = z
  .object({
    id: z.string().min(1).max(64).nullable(),
    text: z.string().min(1).max(DIRECTOR_LIMITS.requestText),
    action: z.enum(REQUEST_ACTIONS),
    quote: z.string().max(DIRECTOR_LIMITS.quote).nullable(),
  })
  .strict();

export const directorSchema = z
  .object({
    turn_kind: z.enum(TURN_KINDS),
    will_change_image: z.boolean(),
    reply: z.string().max(DIRECTOR_LIMITS.reply),
    what_to_change: z.string().max(DIRECTOR_LIMITS.field),
    what_to_put: z.string().max(DIRECTOR_LIMITS.field),
    inventory_keep: z
      .array(z.string().max(DIRECTOR_LIMITS.keepName))
      .max(DIRECTOR_LIMITS.keepItems),
    what_i_see: z.string().max(DIRECTOR_LIMITS.seen),
    undo_target: z.union([z.literal('previous'), z.number().int().min(1)]).nullable(),
    layer_ops: z.array(layerOpSchema).max(DIRECTOR_LIMITS.layerOps),
    requests: z.array(requestSchema).max(DIRECTOR_LIMITS.requests),
    refusal: z.enum(REFUSALS).nullable(),
  })
  .strict();

export type DirectorPlan = z.infer<typeof directorSchema>;
export type DirectorLayerOp = DirectorPlan['layer_ops'][number];
export type DirectorRequest = DirectorPlan['requests'][number];

const str = (max: number) => ({ type: 'string', maxLength: max });

const layerOpJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'layer', 'text', 'position', 'replace'],
  properties: {
    op: { type: 'string', enum: [...LAYER_OPS] },
    layer: { anyOf: [{ type: 'null' }, LAYER_OBJECT_JSON_SCHEMA] },
    text: { anyOf: [{ type: 'null' }, TEXT_OBJECT_JSON_SCHEMA] },
    position: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['side', 'zone'],
          properties: {
            side: { type: 'string', enum: [...LOGO_SIDES] },
            zone: { type: 'string', enum: [...LAYER_ZONES] },
          },
        },
      ],
    },
    replace: { type: 'boolean' },
  },
};

const requestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text', 'action', 'quote'],
  properties: {
    id: nullableString,
    text: str(DIRECTOR_LIMITS.requestText),
    action: { type: 'string', enum: [...REQUEST_ACTIONS] },
    quote: nullableString,
  },
};

/** `text.format` do `/responses` (strict: todos os campos presentes, `null` quando não valem). */
export const DIRECTOR_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'scene_director',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'turn_kind',
      'will_change_image',
      'reply',
      'what_to_change',
      'what_to_put',
      'inventory_keep',
      'what_i_see',
      'undo_target',
      'layer_ops',
      'requests',
      'refusal',
    ],
    properties: {
      turn_kind: { type: 'string', enum: [...TURN_KINDS] },
      will_change_image: { type: 'boolean' },
      reply: str(DIRECTOR_LIMITS.reply),
      what_to_change: str(DIRECTOR_LIMITS.field),
      what_to_put: str(DIRECTOR_LIMITS.field),
      inventory_keep: {
        type: 'array',
        maxItems: DIRECTOR_LIMITS.keepItems,
        items: str(DIRECTOR_LIMITS.keepName),
      },
      what_i_see: str(DIRECTOR_LIMITS.seen),
      undo_target: {
        anyOf: [{ type: 'null' }, { type: 'string', enum: ['previous'] }, { type: 'integer' }],
      },
      layer_ops: { type: 'array', maxItems: DIRECTOR_LIMITS.layerOps, items: layerOpJsonSchema },
      requests: { type: 'array', maxItems: DIRECTOR_LIMITS.requests, items: requestJsonSchema },
      refusal: { type: ['string', 'null'], enum: [...REFUSALS, null] },
    },
  },
};
