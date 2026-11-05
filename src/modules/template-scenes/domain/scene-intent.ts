import { z } from 'zod';
import { fold } from './scene-request-text';

/**
 * Intenção reconhecida pelo modelo (D-19): o modelo decide o que o cliente quer; o código valida a saída
 * com schema fechado e decide o efeito (`planFromIntent`).
 */

export const INTENT_ACTIONS = [
  'edit',
  'remove',
  'add_element',
  'integrate',
  'global_adjust',
  'new_image',
  'move_item',
  'layer_move',
  'layer_resize',
  'layer_remove',
  'set_text',
  'ask_region',
] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];

const ZONES = ['header', 'body', 'footer'] as const;
const LAYER_KINDS = ['logo', 'text', 'generated'] as const;
const SIDES = ['left', 'right', 'toggle'] as const;
const DIRECTIONS = ['bigger', 'smaller'] as const;
const PLACEMENTS = ['below-logo', 'top', 'bottom', 'none'] as const;

/** Texto vazio vale como ausente: o modelo às vezes devolve "" no lugar de `null`. */
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().max(max).nullable(),
  );

const intentSchema = z
  .object({
    action: z.enum(INTENT_ACTIONS),
    zone: z.enum(ZONES).nullable(),
    object: optionalText(80),
    subject: optionalText(80),
    imagePrompt: optionalText(500),
    relativePlace: z.boolean(),
    layer: z
      .object({
        kind: z.enum(LAYER_KINDS),
        name: optionalText(80),
        side: z.enum(SIDES).nullable(),
        direction: z.enum(DIRECTIONS).nullable(),
      })
      .strict()
      .nullable(),
    text: z
      .object({ value: z.string().min(1).max(200), placement: z.enum(PLACEMENTS) })
      .strict()
      .nullable(),
  })
  .strict();

export type SceneIntent = z.infer<typeof intentSchema>;
export type IntentLayer = NonNullable<SceneIntent['layer']>;

const nullableEnum = (values: readonly string[]) => ({
  type: ['string', 'null'],
  enum: [...values, null],
});
const nullableString = { type: ['string', 'null'] };

/** Schema do `response_format` (strict: todos os campos presentes, `null` quando não valem). */
export const INTENT_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'scene_intent',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'action',
      'zone',
      'object',
      'subject',
      'imagePrompt',
      'relativePlace',
      'layer',
      'text',
    ],
    properties: {
      action: { type: 'string', enum: [...INTENT_ACTIONS] },
      zone: nullableEnum(ZONES),
      object: nullableString,
      subject: nullableString,
      imagePrompt: nullableString,
      relativePlace: { type: 'boolean' },
      layer: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'name', 'side', 'direction'],
            properties: {
              kind: { type: 'string', enum: [...LAYER_KINDS] },
              name: nullableString,
              side: nullableEnum(SIDES),
              direction: nullableEnum(DIRECTIONS),
            },
          },
        ],
      },
      text: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'placement'],
            properties: {
              value: { type: 'string' },
              placement: { type: 'string', enum: [...PLACEMENTS] },
            },
          },
        ],
      },
    },
  },
};

export type IntentParse = { ok: true; intent: SceneIntent } | { ok: false; reason: string };

const wordsOf = (text: string): string[] =>
  fold(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Alguma palavra do valor (3 letras ou mais) aparece na mensagem, inclusive no plural ou na raiz. */
function sharesWord(value: string, message: string): boolean {
  const known = wordsOf(message);
  return wordsOf(value)
    .filter((word) => word.length >= 3)
    .some((word) => known.some((other) => other.startsWith(word) || word.startsWith(other)));
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Regras do código que o schema não expressa: palavras da mensagem, texto literal e campos exigidos pela ação. */
function semanticProblem(intent: SceneIntent, message: string): string | null {
  for (const field of ['object', 'subject'] as const) {
    const value = intent[field];
    if (value && !sharesWord(value, message)) return `${field} sem palavra da mensagem`;
  }
  if (intent.text && !collapse(message).includes(collapse(intent.text.value))) {
    return 'texto exato fora da mensagem';
  }
  if (intent.action === 'add_element' && !intent.subject) return 'add_element sem subject';
  if (intent.action === 'set_text' && !intent.text) return 'set_text sem text';
  if (intent.action.startsWith('layer_') && !intent.layer) return `${intent.action} sem layer`;
  return null;
}

/** Valida a saída do modelo: JSON, schema fechado e regras do código. Nunca lança. */
export function parseIntent(raw: string, message: string): IntentParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON inválido' };
  }
  const parsed = intentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `schema: ${issue.path.join('.') || 'raiz'} (${issue.message})` };
  }
  const problem = semanticProblem(parsed.data, message);
  return problem ? { ok: false, reason: problem } : { ok: true, intent: parsed.data };
}
