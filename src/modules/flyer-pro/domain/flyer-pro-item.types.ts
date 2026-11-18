import type { FlyerProItem } from '../entities/flyer-pro-item.entity';

/** Os campos do item que o corpo do `PATCH` pode trazer, como o DTO os entrega (ausente = não muda, `null` = limpa). */
export interface FlyerProItemEntry {
  id: string;
  position?: number | null;
  name?: string | null;
  sourceName?: string | null;
  price?: Record<string, unknown> | null;
  unit?: string | null;
  category?: string | null;
  isAlcoholic?: boolean | null;
  ean?: string | null;
  galleryImageId?: string | null;
  imageUrl?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  imageOrigin?: string | null;
  imported?: Record<string, unknown> | null;
  categoryDecision?: 'accept' | 'reject' | 'blocked' | null;
  categoryDecisionReason?: string | null;
  imageDecision?: 'reject' | null;
  spellDecision?: 'accept' | 'reject' | null;
}

/** Os campos do item que o cliente escreve (o resto, o servidor deriva). */
export const ITEM_FIELD_KEYS = [
  'position',
  'name',
  'sourceName',
  'price',
  'unit',
  'category',
  'isAlcoholic',
  'ean',
  'galleryImageId',
  'imageUrl',
  'imageWidth',
  'imageHeight',
  'imageOrigin',
  'imported',
] as const;

export type ItemFieldKey = (typeof ITEM_FIELD_KEYS)[number];
export type ItemFields = Pick<FlyerProItem, ItemFieldKey>;

/** Os cinco campos da foto: andam juntos, todos preenchidos ou todos nulos. */
export const IMAGE_GROUP_KEYS = [
  'galleryImageId',
  'imageUrl',
  'imageWidth',
  'imageHeight',
  'imageOrigin',
] as const satisfies readonly ItemFieldKey[];

export type StoredItem = FlyerProItem;

/** O item como o `PATCH` o vê: a entrada, a linha gravada (ou nenhuma), o resultado da mescla e o modo `replaceAll`. */
export interface ItemDraft {
  entry: FlyerProItemEntry;
  stored: StoredItem | null;
  merged: ItemFields;
  replaceAll: boolean;
}
