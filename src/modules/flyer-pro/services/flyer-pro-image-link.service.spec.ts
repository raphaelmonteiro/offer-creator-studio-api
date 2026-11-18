import { Logger, NotFoundException } from '@nestjs/common';
import type { GalleryProductLinkService } from '../../gallery/gallery-product-link.service';
import type { PhotoChoice } from '../domain/flyer-pro-photo-choice';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { FlyerProImageLinkService } from './flyer-pro-image-link.service';
import { itemRow } from './flyer-pro-documents.service.testutil';

const PICCIN = 'c2e28b36-5c8e-4fa0-9f37-7c3357ac8487';
const PHOTO = '141da073-e2ab-4c8e-bb79-28e24074f743';
const OTHER_PHOTO = '1798958c-04fc-4014-9921-a90755c9bdf3';

const choiceOf = (over: Partial<PhotoChoice> = {}): PhotoChoice => ({
  itemId: 'i1',
  galleryImageId: PHOTO,
  previousGalleryImageId: null,
  imageOrigin: 'picker',
  ...over,
});

function makeService(linkProduct = jest.fn().mockResolvedValue({})) {
  const gallery = { linkProduct } as unknown as GalleryProductLinkService;
  return { service: new FlyerProImageLinkService(gallery), linkProduct };
}

const register = (
  service: FlyerProImageLinkService,
  choices: PhotoChoice[],
  items: FlyerProItem[] = [itemRow()],
  clientId: string | null = PICCIN,
) => service.register({ choices, items, clientId });

describe('FlyerProImageLinkService: quando registrar a escolha', () => {
  it.each(['suggestion', 'picker', 'upload', 'pixabay'])(
    'foto nova com origem %s registra o nome do item na foto',
    async (imageOrigin) => {
      const { service, linkProduct } = makeService();
      const warnings = await register(service, [choiceOf({ imageOrigin })]);
      expect(warnings).toEqual([]);
      expect(linkProduct).toHaveBeenCalledTimes(1);
      expect(linkProduct).toHaveBeenCalledWith(
        PHOTO,
        expect.objectContaining({ productName: 'ABACATE' }),
      );
    },
  );

  it('origem match não registra, sem foto antes nem com outra foto antes', async () => {
    const { service, linkProduct } = makeService();
    await register(service, [choiceOf({ imageOrigin: 'match' })]);
    await register(service, [
      choiceOf({ imageOrigin: 'match', previousGalleryImageId: OTHER_PHOTO }),
    ]);
    expect(linkProduct).not.toHaveBeenCalled();
  });

  it('foto igual à gravada não registra (Manter a desta tela)', async () => {
    const { service, linkProduct } = makeService();
    await register(service, [choiceOf({ previousGalleryImageId: PHOTO })]);
    expect(linkProduct).not.toHaveBeenCalled();
  });

  it('trocar a foto por outra de escolha humana registra a nova', async () => {
    const { service, linkProduct } = makeService();
    await register(service, [choiceOf({ previousGalleryImageId: OTHER_PHOTO })]);
    expect(linkProduct).toHaveBeenCalledWith(PHOTO, expect.anything());
  });

  it('grupo nulo (tirar a foto) não registra', async () => {
    const { service, linkProduct } = makeService();
    await register(service, [
      choiceOf({ galleryImageId: null, imageOrigin: null, previousGalleryImageId: PHOTO }),
    ]);
    expect(linkProduct).not.toHaveBeenCalled();
  });

  it('origem nula não registra', async () => {
    const { service, linkProduct } = makeService();
    await register(service, [choiceOf({ imageOrigin: null })]);
    expect(linkProduct).not.toHaveBeenCalled();
  });

  it('sem nenhuma escolha não chama a Galeria e devolve lista vazia', async () => {
    const { service, linkProduct } = makeService();
    expect(await register(service, [])).toEqual([]);
    expect(linkProduct).not.toHaveBeenCalled();
  });
});

describe('FlyerProImageLinkService: o que é gravado na foto', () => {
  it('usa sourceName quando existe, e name quando sourceName é nulo', async () => {
    const { service, linkProduct } = makeService();
    const file = itemRow({
      id: 'i1',
      name: 'FILÉ DE TILÁPIA CONGELADO',
      sourceName: 'FILE DE TILAPIA CONJELADO',
    });
    const bread = itemRow({ id: 'i2', name: 'PÃO FRANCÊS KG', sourceName: null });
    await register(service, [choiceOf(), choiceOf({ itemId: 'i2' })], [file, bread]);
    expect(linkProduct.mock.calls.map(([, input]) => input.productName)).toEqual([
      'FILE DE TILAPIA CONJELADO',
      'PÃO FRANCÊS KG',
    ]);
  });

  it('leva o EAN do item como está e o cliente do encarte', async () => {
    const { service, linkProduct } = makeService();
    const beer = itemRow({ name: 'CERVEJA PILSEN GARRAFA 600ML', ean: '7896000000017' });
    await register(service, [choiceOf()], [beer]);
    expect(linkProduct).toHaveBeenCalledWith(PHOTO, {
      productName: 'CERVEJA PILSEN GARRAFA 600ML',
      ean: '7896000000017',
      clientId: PICCIN,
    });
  });

  it('EAN com dígito errado vai como está e não gera aviso', async () => {
    const linkProduct = jest
      .fn()
      .mockResolvedValue({ ean: { ean: '7896000000018', status: 'invalid' } });
    const { service } = makeService(linkProduct);
    const warnings = await register(service, [choiceOf()], [itemRow({ ean: '7896000000018' })]);
    expect(linkProduct).toHaveBeenCalledWith(
      PHOTO,
      expect.objectContaining({ ean: '7896000000018' }),
    );
    expect(warnings).toEqual([]);
  });

  it('item sem EAN e encarte sem cliente vão com nulos', async () => {
    const { service, linkProduct } = makeService();
    await register(service, [choiceOf()], [itemRow()], null);
    expect(linkProduct).toHaveBeenCalledWith(PHOTO, {
      productName: 'ABACATE',
      ean: null,
      clientId: null,
    });
  });
});

describe('FlyerProImageLinkService: falha vira aviso', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const notFound = (code: string) =>
    new NotFoundException({ code, message: 'Imagem não encontrada' });

  it('foto fora da Galeria vira GALLERY_IMAGE_NOT_FOUND', async () => {
    const { service } = makeService(
      jest.fn().mockRejectedValue(notFound('GALLERY_IMAGE_NOT_FOUND')),
    );
    expect(await register(service, [choiceOf()])).toEqual([
      { itemId: 'i1', code: 'GALLERY_IMAGE_NOT_FOUND' },
    ]);
  });

  it.each([
    ['erro inesperado', new Error('connection reset')],
    ['404 com outro código', notFound('OUTRO')],
    ['valor lançado que não é Error', 'texto'],
  ])('%s vira GALLERY_LINK_FAILED', async (_name, error) => {
    const { service } = makeService(jest.fn().mockRejectedValue(error));
    expect(await register(service, [choiceOf()])).toEqual([
      { itemId: 'i1', code: 'GALLERY_LINK_FAILED' },
    ]);
  });

  it('uma falha entre três não interrompe as outras, e só ela vira aviso', async () => {
    const linkProduct = jest.fn((photoId: string) =>
      photoId === OTHER_PHOTO
        ? Promise.reject(notFound('GALLERY_IMAGE_NOT_FOUND'))
        : Promise.resolve({}),
    );
    const { service } = makeService(linkProduct);
    const items = [itemRow({ id: 'i1' }), itemRow({ id: 'i2' }), itemRow({ id: 'i3' })];
    const warnings = await register(
      service,
      [
        choiceOf({ itemId: 'i1', galleryImageId: 'p1' }),
        choiceOf({ itemId: 'i2', galleryImageId: OTHER_PHOTO }),
        choiceOf({ itemId: 'i3', galleryImageId: 'p3' }),
      ],
      items,
    );
    expect(warnings).toEqual([{ itemId: 'i2', code: 'GALLERY_IMAGE_NOT_FOUND' }]);
    expect(linkProduct.mock.calls.map(([photoId]) => photoId)).toEqual(['p1', OTHER_PHOTO, 'p3']);
  });

  it('a falha vai ao log com o id do item e o código', async () => {
    const { service } = makeService(jest.fn().mockRejectedValue(new Error('boom')));
    await register(service, [choiceOf({ itemId: 'i1' })]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining('i1'));
    expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining('GALLERY_LINK_FAILED'));
  });

  it('escolha de um item que falta na lista vira GALLERY_LINK_FAILED, sem derrubar o salvar', async () => {
    const { service, linkProduct } = makeService();
    const warnings = await register(service, [choiceOf({ itemId: 'sumiu' })], [itemRow()]);
    expect(warnings).toEqual([{ itemId: 'sumiu', code: 'GALLERY_LINK_FAILED' }]);
    expect(linkProduct).not.toHaveBeenCalled();
  });
});
