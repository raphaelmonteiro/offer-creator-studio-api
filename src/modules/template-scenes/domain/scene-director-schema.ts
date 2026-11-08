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
 * `will_change_image` por tabela do código, nunca de texto livre. Os blocos de `image` (D-51, em inglês) montam o
 * prompt da imagem; eles e `what_i_see` (auditoria) nunca vão ao cliente.
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

/** D-51: só a logo é recusada (sempre camada); texto e preço são pintados a pedido. */
export const REFUSALS = ['painted_logo'] as const;
export type PaintedRefusal = (typeof REFUSALS)[number];

export const IMAGE_ZONES = ['header', 'body', 'footer', 'marked', 'whole'] as const;
export type ImageZone = (typeof IMAGE_ZONES)[number];
export const IMAGE_SIDES = ['left', 'center', 'right'] as const;

export const LAYER_OPS = ['move', 'resize', 'remove', 'set_text', 'add_logo'] as const;
const LOGO_SIDES = ['left', 'center', 'right'] as const;
const REQUEST_ACTIONS = ['open', 'drop'] as const;

/** Limites do schema (caracteres, itens). */
export const DIRECTOR_LIMITS = {
  reply: 260,
  composition: 300,
  style: 200,
  change: 500,
  preserveItems: 12,
  preserveItem: 120,
  exactLines: 4,
  exactLine: 80,
  seen: 500,
  layerOps: 6,
  requests: 8,
  requestText: 80,
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

const imageSchema = z
  .object({
    composition: z.string().max(DIRECTOR_LIMITS.composition),
    style: z.string().max(DIRECTOR_LIMITS.style),
    change: z.string().max(DIRECTOR_LIMITS.change),
    region: z.object({ zone: z.enum(IMAGE_ZONES), side: z.enum(IMAGE_SIDES).nullable() }).strict(),
    preserve: z
      .array(z.string().max(DIRECTOR_LIMITS.preserveItem))
      .max(DIRECTOR_LIMITS.preserveItems),
    exact_text: z.array(z.string().max(DIRECTOR_LIMITS.exactLine)).max(DIRECTOR_LIMITS.exactLines),
  })
  .strict();

export const directorSchema = z
  .object({
    turn_kind: z.enum(TURN_KINDS),
    will_change_image: z.boolean(),
    reply: z.string().max(DIRECTOR_LIMITS.reply),
    image: imageSchema.nullable(),
    what_i_see: z.string().max(DIRECTOR_LIMITS.seen),
    undo_target: z.union([z.literal('previous'), z.number().int().min(1)]).nullable(),
    layer_ops: z.array(layerOpSchema).max(DIRECTOR_LIMITS.layerOps),
    requests: z.array(requestSchema).max(DIRECTOR_LIMITS.requests),
    refusal: z.enum(REFUSALS).nullable(),
  })
  .strict();

export type DirectorPlan = z.infer<typeof directorSchema>;
export type DirectorImage = z.infer<typeof imageSchema>;
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

const imageJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['composition', 'style', 'change', 'region', 'preserve', 'exact_text'],
  properties: {
    composition: str(DIRECTOR_LIMITS.composition),
    style: str(DIRECTOR_LIMITS.style),
    change: str(DIRECTOR_LIMITS.change),
    region: {
      type: 'object',
      additionalProperties: false,
      required: ['zone', 'side'],
      properties: {
        zone: { type: 'string', enum: [...IMAGE_ZONES] },
        side: { type: ['string', 'null'], enum: [...IMAGE_SIDES, null] },
      },
    },
    preserve: {
      type: 'array',
      maxItems: DIRECTOR_LIMITS.preserveItems,
      items: str(DIRECTOR_LIMITS.preserveItem),
    },
    exact_text: {
      type: 'array',
      maxItems: DIRECTOR_LIMITS.exactLines,
      items: str(DIRECTOR_LIMITS.exactLine),
    },
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
      'image',
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
      image: { anyOf: [{ type: 'null' }, imageJsonSchema] },
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
