import { itemRow } from '../services/flyer-pro-documents.service.testutil';
import { draftOf } from './flyer-pro-item-merge';
import { photoChoiceOf } from './flyer-pro-photo-choice';

const PHOTO = '141da073-e2ab-4c8e-bb79-28e24074f743';
const OTHER_PHOTO = '1798958c-04fc-4014-9921-a90755c9bdf3';
const GROUP = {
  galleryImageId: PHOTO,
  imageUrl: 'http://localhost:3101/uploads/gallery/abacate.png',
  imageWidth: 640,
  imageHeight: 427,
  imageOrigin: 'picker',
};

describe('photoChoiceOf', () => {
  it('item novo com o grupo da foto: a foto nova, sem foto antes', () => {
    const draft = draftOf({ id: 'i1', name: 'PÃO FRANCÊS KG', ...GROUP }, null, false);
    expect(photoChoiceOf(draft)).toEqual({
      itemId: 'i1',
      galleryImageId: PHOTO,
      previousGalleryImageId: null,
      imageOrigin: 'picker',
    });
  });

  it('item gravado com outra foto: devolve a foto antes e a nova', () => {
    const stored = itemRow({ galleryImageId: OTHER_PHOTO, imageOrigin: 'match' });
    expect(photoChoiceOf(draftOf({ id: 'i1', ...GROUP }, stored, false))).toEqual({
      itemId: 'i1',
      galleryImageId: PHOTO,
      previousGalleryImageId: OTHER_PHOTO,
      imageOrigin: 'picker',
    });
  });

  it('grupo todo nulo: foto nula e origem nula', () => {
    const stored = itemRow({ galleryImageId: PHOTO, imageOrigin: 'picker' });
    const nulls = {
      galleryImageId: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      imageOrigin: null,
    };
    expect(photoChoiceOf(draftOf({ id: 'i1', ...nulls }, stored, false))).toEqual({
      itemId: 'i1',
      galleryImageId: null,
      previousGalleryImageId: PHOTO,
      imageOrigin: null,
    });
  });

  it('corpo sem o grupo da foto (só o preço): nenhuma escolha', () => {
    const stored = itemRow({ galleryImageId: PHOTO, imageOrigin: 'match' });
    expect(
      photoChoiceOf(draftOf({ id: 'i1', price: { kind: 'simple', cents: 799 } }, stored, false)),
    ).toBeNull();
  });
});
