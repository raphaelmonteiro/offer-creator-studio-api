/**
 * Dados de teste da foto do item (só testes): a foto da Galeria escolhida no seletor, outra foto da Galeria e o grupo
 * da foto com os cinco campos preenchidos ou todos nulos.
 */

export const PHOTO = '141da073-e2ab-4c8e-bb79-28e24074f743';
export const OTHER_PHOTO = '1798958c-04fc-4014-9921-a90755c9bdf3';

export const PHOTO_GROUP = {
  galleryImageId: PHOTO,
  imageUrl: 'http://localhost:3101/uploads/gallery/abacate.png',
  imageWidth: 640,
  imageHeight: 427,
  imageOrigin: 'picker',
};

export const NO_PHOTO_GROUP = {
  galleryImageId: null,
  imageUrl: null,
  imageWidth: null,
  imageHeight: null,
  imageOrigin: null,
};
