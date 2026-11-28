import { itemRow } from '../services/flyer-pro-documents.service.testutil';
import {
  NO_PHOTO_GROUP,
  OTHER_PHOTO,
  PHOTO,
  PHOTO_GROUP,
} from '../testing/flyer-pro-photo-group.testutil';
import { draftOf } from './flyer-pro-item-merge';
import { isHumanPhotoChange, photoChoiceOf, PhotoChoice } from './flyer-pro-photo-choice';

describe('photoChoiceOf', () => {
  it('item novo com o grupo da foto: a foto nova, sem foto antes', () => {
    const draft = draftOf({ id: 'i1', name: 'PÃO FRANCÊS KG', ...PHOTO_GROUP }, null, false);
    expect(photoChoiceOf(draft)).toEqual({
      itemId: 'i1',
      galleryImageId: PHOTO,
      previousGalleryImageId: null,
      imageOrigin: 'picker',
    });
  });

  it('item gravado com outra foto: devolve a foto antes e a nova', () => {
    const stored = itemRow({ galleryImageId: OTHER_PHOTO, imageOrigin: 'match' });
    expect(photoChoiceOf(draftOf({ id: 'i1', ...PHOTO_GROUP }, stored, false))).toEqual({
      itemId: 'i1',
      galleryImageId: PHOTO,
      previousGalleryImageId: OTHER_PHOTO,
      imageOrigin: 'picker',
    });
  });

  it('grupo todo nulo: foto nula e origem nula', () => {
    const stored = itemRow({ galleryImageId: PHOTO, imageOrigin: 'picker' });
    expect(photoChoiceOf(draftOf({ id: 'i1', ...NO_PHOTO_GROUP }, stored, false))).toEqual({
      itemId: 'i1',
      galleryImageId: null,
      previousGalleryImageId: PHOTO,
      imageOrigin: null,
    });
  });

  it('só a origem match deixa de ser escolha humana: google conta como pessoa', () => {
    const choice = (imageOrigin: string): PhotoChoice => ({
      itemId: 'i1',
      galleryImageId: PHOTO,
      previousGalleryImageId: null,
      imageOrigin,
    });

    for (const origin of ['suggestion', 'picker', 'upload', 'pixabay', 'google']) {
      expect(isHumanPhotoChange(choice(origin))).toBe(true);
    }
    expect(isHumanPhotoChange(choice('match'))).toBe(false);
  });

  it('corpo sem o grupo da foto (só o preço): nenhuma escolha', () => {
    const stored = itemRow({ galleryImageId: PHOTO, imageOrigin: 'match' });
    expect(
      photoChoiceOf(draftOf({ id: 'i1', price: { kind: 'simple', cents: 799 } }, stored, false)),
    ).toBeNull();
  });
});
