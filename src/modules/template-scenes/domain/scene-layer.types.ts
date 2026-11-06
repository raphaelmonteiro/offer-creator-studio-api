import { z } from 'zod';
import { SceneZoneName } from './scene.types';

/**
 * Tipos e formato das camadas exatas (logo e texto), usados por `processors/scene-layer-actions.ts` e pelo
 * `layer_ops` do Diretor. Nasceram do reconhecimento de intenção por texto, que o Diretor substituiu (D-23).
 */

export type LayerKind = 'logo' | 'text';
export type Side = 'left' | 'right' | 'toggle';

export interface ParsedText {
  text: string;
  placement: 'below-logo' | 'top' | 'bottom' | 'none';
  /** "muda o texto para ...": troca o texto existente em vez de criar outro. */
  replace: boolean;
}

export interface LogoPosition {
  side: 'left' | 'center' | 'right';
  zone: SceneZoneName;
}

/** Elemento escolhido por seleção (`elementId`) ou pelo tipo citado (`kind`). */
export type LayerTarget = { elementId: string } | { kind: LayerKind };

/** Mudança exata numa camada (logo, texto, elemento adicionado), sem IA. */
export type LayerAction =
  | ({ type: 'add_logo'; assetId: string } & LogoPosition)
  | ({ type: 'set_text'; elementId?: string } & ParsedText)
  | { type: 'move'; target: LayerTarget; side: Side }
  | { type: 'resize'; target: LayerTarget; direction: 'bigger' | 'smaller' }
  | { type: 'remove'; target: LayerTarget };

export const LAYER_ZONES = ['header', 'body', 'footer'] as const;
export const LAYER_INTENT_KINDS = ['logo', 'text', 'generated'] as const;
export const LAYER_SIDES = ['left', 'right', 'toggle'] as const;
export const LAYER_DIRECTIONS = ['bigger', 'smaller'] as const;
export const TEXT_PLACEMENTS = ['below-logo', 'top', 'bottom', 'none'] as const;

/** Texto vazio vale como ausente: o modelo às vezes devolve "" no lugar de `null`. */
export const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z.string().max(max).nullable(),
  );

/** Camada citada pelo modelo: tipo, nome, lado e direção. */
export const layerIntentSchema = z
  .object({
    kind: z.enum(LAYER_INTENT_KINDS),
    name: optionalText(80),
    side: z.enum(LAYER_SIDES).nullable(),
    direction: z.enum(LAYER_DIRECTIONS).nullable(),
  })
  .strict();

/** Texto exato pedido pelo cliente e onde fica. */
export const textIntentSchema = z
  .object({ value: z.string().min(1).max(200), placement: z.enum(TEXT_PLACEMENTS) })
  .strict();

export type IntentLayer = z.infer<typeof layerIntentSchema>;
export type IntentText = z.infer<typeof textIntentSchema>;

export const nullableEnum = (values: readonly string[]) => ({
  type: ['string', 'null'],
  enum: [...values, null],
});
export const nullableString = { type: ['string', 'null'] };

/** JSON schema (strict) da camada e do texto, sem o `null` externo. */
export const LAYER_OBJECT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'name', 'side', 'direction'],
  properties: {
    kind: { type: 'string', enum: [...LAYER_INTENT_KINDS] },
    name: nullableString,
    side: nullableEnum(LAYER_SIDES),
    direction: nullableEnum(LAYER_DIRECTIONS),
  },
};

export const TEXT_OBJECT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'placement'],
  properties: {
    value: { type: 'string' },
    placement: { type: 'string', enum: [...TEXT_PLACEMENTS] },
  },
};
