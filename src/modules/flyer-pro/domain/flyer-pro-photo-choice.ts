import { FLYER_PRO_IMAGE_ORIGINS } from './flyer-pro-categories';
import type { ItemDraft } from './flyer-pro-item.types';

/** A foto de um item citada no corpo do `PATCH`, ao lado da que estava gravada (U2.7, change 27). */
export interface PhotoChoice {
  itemId: string;
  /** A foto como o item ficou; nula quando o corpo tirou a foto. */
  galleryImageId: string | null;
  /** A foto gravada antes do corpo; nula em item novo ou sem foto. */
  previousGalleryImageId: string | null;
  imageOrigin: string | null;
}

/** As origens que são escolha de uma pessoa: tudo menos `match`, a foto que o job aplicou. */
const HUMAN_ORIGINS: readonly string[] = FLYER_PRO_IMAGE_ORIGINS.filter(
  (origin) => origin !== 'match',
);

/**
 * A escolha de foto de um item de `upsert`, lida dentro da transação do salvar; `null` quando o corpo não trouxe o
 * grupo da foto (o grupo anda inteiro, então `galleryImageId` ausente é grupo ausente). Os valores são os do item
 * como ficou depois da mescla.
 */
export function photoChoiceOf(draft: ItemDraft): PhotoChoice | null {
  if (draft.entry.galleryImageId === undefined) return null;
  return {
    itemId: draft.entry.id,
    galleryImageId: draft.merged.galleryImageId,
    previousGalleryImageId: draft.stored?.galleryImageId ?? null,
    imageOrigin: draft.merged.imageOrigin,
  };
}

/** Só registra foto preenchida, diferente da gravada antes e de escolha humana. */
export const isHumanPhotoChange = (choice: PhotoChoice): boolean =>
  choice.galleryImageId !== null &&
  choice.galleryImageId !== choice.previousGalleryImageId &&
  HUMAN_ORIGINS.includes(choice.imageOrigin);
