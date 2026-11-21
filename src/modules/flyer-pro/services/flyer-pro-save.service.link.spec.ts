import { Logger } from '@nestjs/common';
import type { GalleryProductLinkService } from '../../gallery/gallery-product-link.service';
import { FlyerProImageLinkService } from './flyer-pro-image-link.service';
import {
  ABACATE,
  makeSavingPhoto,
  PHOTO,
  photoBody,
  PHOTO_CHOICE,
  recordSaveOrder,
  SAVED_ABACATE,
} from './flyer-pro-save.service.link.testutil';
import { saveBody, storedDocument } from './flyer-pro-save.service.testutil';

describe('FlyerProSaveService.save: o registro da foto depois do commit', () => {
  it('registra uma vez, depois que a transação confirma, com as escolhas e os itens como ficaram', async () => {
    const made = makeSavingPhoto();
    const { service, links } = made;
    const order = recordSaveOrder(made);

    await service.save('ana', 'd1', photoBody());

    expect(order).toEqual(['commit', 'register']);
    expect(links.register).toHaveBeenCalledTimes(1);
    expect(links.register).toHaveBeenCalledWith({
      choices: [PHOTO_CHOICE],
      items: [SAVED_ABACATE],
      clientId: 'c1',
    });
  });

  it('o cliente do registro é o do encarte depois do Setup do mesmo corpo', async () => {
    const { service, setup, links } = makeSavingPhoto();
    setup.apply.mockResolvedValue({ clientId: 'c2' });

    await service.save('ana', 'd1', photoBody({ setup: { clientId: 'c2' } }));

    expect(links.register).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c2' }));
  });

  it('sem clientId no Setup, o cliente do registro é o que o encarte já tinha', async () => {
    const { service, links } = makeSavingPhoto();

    await service.save('ana', 'd1', photoBody({ setup: { name: 'Novo nome' } }));

    expect(links.register).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1' }));
  });

  it('a resposta traz os avisos que o registro devolveu, sem mudar a revisão nem a foto', async () => {
    const { service, links } = makeSavingPhoto();
    links.register.mockResolvedValue([{ itemId: ABACATE, code: 'GALLERY_LINK_FAILED' }]);

    const view = await service.save('ana', 'd1', photoBody());

    expect(view.revision).toBe(38);
    expect(view.applied).toBe(true);
    expect(view.linkWarnings).toEqual([{ itemId: ABACATE, code: 'GALLERY_LINK_FAILED' }]);
    expect(view.items[0]).toMatchObject({
      id: ABACATE,
      galleryImageId: PHOTO,
      imageOrigin: 'picker',
    });
  });

  it('sem falha, linkWarnings é lista vazia', async () => {
    const { service } = makeSavingPhoto();
    expect((await service.save('ana', 'd1', photoBody())).linkWarnings).toEqual([]);
  });

  describe('com o serviço de registro de verdade e a Galeria lançando erro inesperado', () => {
    beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
    afterEach(() => jest.restoreAllMocks());

    it('responde 200 na revisão 38, com a foto no item, e o ABACATE em GALLERY_LINK_FAILED', async () => {
      const { service, links } = makeSavingPhoto(storedDocument({ revision: 37 }));
      const gallery = { linkProduct: jest.fn().mockRejectedValue(new Error('boom')) };
      const real = new FlyerProImageLinkService(gallery as unknown as GalleryProductLinkService);
      links.register.mockImplementation((registration) => real.register(registration));

      const view = await service.save('ana', 'd1', photoBody());

      expect(view.revision).toBe(38);
      expect(view.items).toEqual([expect.objectContaining({ id: ABACATE })]);
      expect(view.linkWarnings).toEqual([{ itemId: ABACATE, code: 'GALLERY_LINK_FAILED' }]);
    });
  });
});

describe('FlyerProSaveService.save: o que nunca registra', () => {
  it('reenvio do mesmo corpo: não chama o registro e linkWarnings é vazio', async () => {
    const { service, links } = makeSavingPhoto(storedDocument({ lastMutationId: 'M1' }));

    const view = await service.save('ana', 'd1', photoBody({ mutationId: 'M1' }));

    expect(view.replayed).toBe(true);
    expect(view.linkWarnings).toEqual([]);
    expect(links.register).not.toHaveBeenCalled();
  });

  it('regravação de conferência aplicada: não chama o registro', async () => {
    const { service, links } = makeSavingPhoto();

    await service.save('ana', 'd1', saveBody({ renderDigest: 'c41f0a97d2be8813' }));

    expect(links.register).not.toHaveBeenCalled();
  });

  it('regravação de conferência descartada (revisão velha): não chama o registro', async () => {
    const { service, links } = makeSavingPhoto();

    const view = await service.save(
      'ana',
      'd1',
      saveBody({ expectedRevision: 30, renderDigest: 'c41f0a97d2be8813' }),
    );

    expect(view.applied).toBe(false);
    expect(links.register).not.toHaveBeenCalled();
  });

  it('corpo recusado (422 do ramo items): nada é registrado', async () => {
    const { service, items, links } = makeSavingPhoto();
    items.apply.mockRejectedValue(new Error('FLYER_PRO_ITEM_INVALID'));

    await expect(service.save('ana', 'd1', photoBody())).rejects.toThrow('FLYER_PRO_ITEM_INVALID');

    expect(links.register).not.toHaveBeenCalled();
  });

  it('conflito de revisão (409): nada é registrado', async () => {
    const { service, links } = makeSavingPhoto();

    await expect(
      service.save('ana', 'd1', photoBody({ expectedRevision: 30 })),
    ).rejects.toMatchObject({
      response: { code: 'REVISION_CONFLICT' },
    });

    expect(links.register).not.toHaveBeenCalled();
  });

  it('PATCH sem o ramo items (só o Setup): não chama o registro', async () => {
    const { service, links } = makeSavingPhoto();

    await service.save('ana', 'd1', saveBody({ setup: { name: 'Novo nome' } }));

    expect(links.register).not.toHaveBeenCalled();
  });
});
