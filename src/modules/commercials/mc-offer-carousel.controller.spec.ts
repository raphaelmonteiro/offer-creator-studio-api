import { BadRequestException } from '@nestjs/common';
import { McOfferCarouselController } from './mc-offer-carousel.controller';
import { McOfferCarouselService } from './services/mc-offer-carousel.service';

/** Tarefa 6.8 — rotas do F2: correção por oferta e "atualizar oferta" do catálogo. */
describe('McOfferCarouselController (tarefa 6.8)', () => {
  const user = { id: 'u1' };
  const P = '11111111-1111-4111-8111-111111111111';
  let service: { updateOffer: jest.Mock; refreshOfferFromCatalog: jest.Mock };
  let controller: McOfferCarouselController;

  beforeEach(() => {
    service = {
      updateOffer: jest.fn().mockResolvedValue({ id: P, offerLineProposal: { scope: 'speech' } }),
      refreshOfferFromCatalog: jest.fn().mockResolvedValue({ id: P }),
    };
    controller = new McOfferCarouselController(service as unknown as McOfferCarouselService);
  });

  it('PATCH /projects/:id/offers/:offerId delega com o DTO; POST .../refresh com a revisão esperada', async () => {
    const dto = { expectedRevision: 3, price: '6,49' };
    await expect(controller.updateOffer(user, P, 'of-oleo', dto)).resolves.toMatchObject({
      offerLineProposal: { scope: 'speech' },
    });
    expect(service.updateOffer).toHaveBeenCalledWith('u1', P, 'of-oleo', dto);
    await controller.refreshOffer(user, P, 'prod-leite#3', { expectedRevision: 4 });
    expect(service.refreshOfferFromCatalog).toHaveBeenCalledWith('u1', P, 'prod-leite#3', 4);
  });

  it('offerId com caracteres fora da forma → 400 antes do service', () => {
    expect(() => controller.updateOffer(user, P, 'of oleo/../x', { expectedRevision: 1 })).toThrow(
      BadRequestException,
    );
    expect(service.updateOffer).not.toHaveBeenCalled();
  });
});
