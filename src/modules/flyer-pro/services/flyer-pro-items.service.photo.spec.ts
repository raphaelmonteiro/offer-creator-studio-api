import { itemRow } from './flyer-pro-documents.service.testutil';
import {
  ABACATE,
  CERVEJA,
  makeItemsManager,
  NEW_ABACATE,
  run,
} from './flyer-pro-items.service.testutil';

const PHOTO = '141da073-e2ab-4c8e-bb79-28e24074f743';
const OTHER_PHOTO = '1798958c-04fc-4014-9921-a90755c9bdf3';
const GROUP = {
  galleryImageId: PHOTO,
  imageUrl: 'http://localhost:3101/uploads/gallery/abacate.png',
  imageWidth: 640,
  imageHeight: 427,
  imageOrigin: 'picker',
};
const NO_PHOTO = {
  galleryImageId: null,
  imageUrl: null,
  imageWidth: null,
  imageHeight: null,
  imageOrigin: null,
};

describe('FlyerProItemsService.apply: as fotos citadas no corpo (photoChoices)', () => {
  it('item novo com o grupo da foto: a foto nova e nenhuma foto antes', async () => {
    const manager = makeItemsManager({ found: [[], []] });

    const { photoChoices } = await run(manager, { upsert: [{ ...NEW_ABACATE, ...GROUP }] });

    expect(photoChoices).toEqual([
      {
        itemId: ABACATE,
        galleryImageId: PHOTO,
        previousGalleryImageId: null,
        imageOrigin: 'picker',
      },
    ]);
  });

  it('item gravado com outra foto: devolve a gravada antes (lida dentro da transação) e a nova', async () => {
    const stored = itemRow({ id: ABACATE, galleryImageId: OTHER_PHOTO, imageOrigin: 'match' });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    const { photoChoices } = await run(manager, { upsert: [{ id: ABACATE, ...GROUP }] });

    expect(photoChoices).toEqual([
      {
        itemId: ABACATE,
        galleryImageId: PHOTO,
        previousGalleryImageId: OTHER_PHOTO,
        imageOrigin: 'picker',
      },
    ]);
  });

  it('"Manter a desta tela": a mesma foto gravada volta como a antes, para o registro pular', async () => {
    const stored = itemRow({ id: ABACATE, ...GROUP });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    const { photoChoices } = await run(manager, {
      replaceAll: true,
      upsert: [{ ...NEW_ABACATE, ...GROUP }],
    });

    expect(photoChoices).toEqual([
      expect.objectContaining({ galleryImageId: PHOTO, previousGalleryImageId: PHOTO }),
    ]);
  });

  it('tirar a foto: o grupo nulo e a foto que estava gravada', async () => {
    const stored = itemRow({ id: ABACATE, ...GROUP });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    const { photoChoices } = await run(manager, { upsert: [{ id: ABACATE, ...NO_PHOTO }] });

    expect(photoChoices).toEqual([
      { itemId: ABACATE, galleryImageId: null, previousGalleryImageId: PHOTO, imageOrigin: null },
    ]);
  });

  it('só o preço de um item com foto do job: nenhuma escolha', async () => {
    const stored = itemRow({ id: CERVEJA, galleryImageId: OTHER_PHOTO, imageOrigin: 'match' });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    const { photoChoices } = await run(manager, {
      upsert: [{ id: CERVEJA, price: { kind: 'simple', cents: 799 } }],
    });

    expect(photoChoices).toEqual([]);
  });

  it('vários itens: só os que trouxeram o grupo, na ordem de upsert', async () => {
    const beer = itemRow({ id: CERVEJA });
    const manager = makeItemsManager({ found: [[beer], [beer]] });

    const { photoChoices } = await run(manager, {
      upsert: [
        { ...NEW_ABACATE, ...GROUP },
        { id: CERVEJA, price: { kind: 'simple', cents: 799 } },
      ],
    });

    expect(photoChoices.map((choice) => choice.itemId)).toEqual([ABACATE]);
  });

  it('corpo sem upsert: lista vazia', async () => {
    const { photoChoices } = await run(makeItemsManager(), { delete: [CERVEJA] });
    expect(photoChoices).toEqual([]);
  });
});
