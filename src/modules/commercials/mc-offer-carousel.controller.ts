import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RevisionDto, UpdateOfferDto } from './dto/quality-v2.dto';
import { McEnabledGuard } from './mc-enabled.guard';
import { McOfferCarouselService } from './services/mc-offer-carousel.service';

/**
 * Rotas do F2 "ofertas em sequência" (change video-formatos-personagem,
 * tarefa 6.8) — correção por oferta e "atualizar oferta" a partir do
 * catálogo. Mesmo prefixo, guards e envelope `{ success, data }` do
 * CommercialsController; num controller próprio para não acoplar o
 * construtor dele.
 */
@ApiTags('commercials')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, McEnabledGuard)
@Controller('commercials')
export class McOfferCarouselController {
  constructor(private readonly offerCarousel: McOfferCarouselService) {}

  /** Id de oferta congelada (uuid gerado na criação ou o id da arte): só a forma. */
  static offerId(value: string): string {
    if (!/^[\w#:.-]{1,120}$/.test(value)) throw new BadRequestException('offerId inválido');
    return value;
  }

  /**
   * Corrige UMA oferta pelo tipo de mudança: foto/badge/unidade/preço anterior
   * → só composição (render + finalize; revisão `assembly_only` depois da
   * entrega); nome/preço atual → fala reescrita (em `offerLineProposal`) e só o
   * TTS/clipe dela refeitos. `dryRun: true` devolve só a proposta.
   */
  @Patch('projects/:id/offers/:offerId')
  @ApiOperation({ summary: 'F2: corrige uma oferta (composição ou fala, pelo tipo de mudança)' })
  updateOffer(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId') offerId: string,
    @Body() dto: UpdateOfferDto,
  ) {
    return this.offerCarousel.updateOffer(
      user.id,
      id,
      McOfferCarouselController.offerId(offerId),
      dto,
    );
  }

  /** "Atualizar oferta": aplica o preço atual do catálogo (mesmo caminho da troca de preço). */
  @Post('projects/:id/offers/:offerId/refresh')
  @ApiOperation({ summary: 'F2: aplica o preço atual do catálogo à oferta' })
  refreshOffer(
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('offerId') offerId: string,
    @Body() dto: RevisionDto,
  ) {
    return this.offerCarousel.refreshOfferFromCatalog(
      user.id,
      id,
      McOfferCarouselController.offerId(offerId),
      dto.expectedRevision,
    );
  }
}
