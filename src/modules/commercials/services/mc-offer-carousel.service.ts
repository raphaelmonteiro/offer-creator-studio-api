import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Product } from '../../products/entities/product.entity';
import { formatOfferPrice } from '../domain/mc-art-offers';
import { buildOfferLineText, plannedTalkDurationS, samePrice } from '../domain/mc-director';
import { carouselPrice } from '../domain/mc-offer-carousel-props';
import { isPipelineV2, resolveQuality } from '../domain/mc-quality';
import { canonicalProduct, carouselOffers, isScriptV2 } from '../domain/mc-script-v2';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McScript, McSceneType, McSealProduct } from '../domain/mc-types';
import { UpdateOfferDto, UpdateScriptV2Dto } from '../dto/quality-v2.dto';
import { McProject } from '../entities/mc-project.entity';
import { McQualityService } from './mc-quality.service';

/** Oferta cujo preço no catálogo difere do congelado (GET /projects/:id → `offersCatalogChanged`). */
export interface McOfferCatalogChange {
  offerId: string;
  catalogId: string;
  /** Preço congelado no vídeo ("24,90"). */
  frozenPrice: string;
  /** Preço atual do catálogo, no mesmo formato. */
  catalogPrice: string;
}

/** Proposta de fala devolvida pela correção de nome/preço (confirmada na revisão do roteiro). */
export interface McOfferLineProposal {
  offerId: string;
  sceneId: string | null;
  previousDialogue: string | null;
  proposedDialogue: string | null;
  /** `speech` = fala reescrita (TTS + clipe dessa fala); `composition` = só render + finalize. */
  scope: 'speech' | 'composition';
  /** Campos que mudaram. */
  changed: string[];
}

const isUuid = (value: string | null | undefined) =>
  !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Ofertas congeladas do F2 com `catalogId` cujo preço ATUAL no catálogo
 * (`products`, ativo) difere do congelado — spec "Catálogo alterado depois":
 * o vídeo mantém o congelado; a revisão mostra "preço do catálogo mudou" com a
 * ação de atualizar a oferta. Outros formatos (ou sem catálogo) → [].
 * Função (não método) para decorar o GET do projeto sem acoplar serviços.
 */
export async function offersCatalogChanges(
  dataSource: DataSource,
  project: Pick<McProject, 'format' | 'script'>,
): Promise<McOfferCatalogChange[]> {
  if (project.format !== 'offer_carousel' || !project.script) return [];
  const offers = carouselOffers(project.script).filter((o) => isUuid(o.catalogId));
  if (offers.length === 0) return [];
  const products = await dataSource.getRepository(Product).find({
    where: { id: In(offers.map((o) => o.catalogId as string)), active: true },
    select: ['id', 'price'],
  });
  const changes: McOfferCatalogChange[] = [];
  for (const offer of offers) {
    const product = products.find((p) => p.id === offer.catalogId);
    const catalogPrice = product ? formatOfferPrice(product.price) : null;
    if (!catalogPrice || samePrice(catalogPrice, offer.price)) continue;
    changes.push({
      offerId: offer.id as string,
      catalogId: offer.catalogId as string,
      frozenPrice: offer.price,
      catalogPrice,
    });
  }
  return changes;
}

/**
 * Correção por tipo de mudança do F2 "ofertas em sequência" (change
 * video-formatos-personagem, tarefa 6.8; spec video-offer-carousel "Correção
 * por tipo de mudança" e "Catálogo alterado depois"):
 *
 * - foto, badge, unidade ou preço anterior → SÓ composição: depois da entrega
 *   abre a revisão `assembly_only` (render_remotion + finalize, sem TTS nem
 *   clipe); antes dela, o roteiro é atualizado e a preparação reaproveita tudo;
 * - nome ou preço ATUAL → a fala da oferta é reescrita pelo line builder do
 *   diretor (ou a fala confirmada pelo usuário em `dialogue`) e o projeto
 *   volta à revisão do roteiro: na preparação só o TTS dessa fala muda de hash
 *   e, na produção, só o `talk` dela (os demais vêm do cache por hash);
 * - catálogo alterado: `offersCatalogChanged` compara as ofertas congeladas
 *   com `products` (por `catalogId`); "atualizar oferta" aplica o preço do
 *   catálogo pelo caminho de nome/preço.
 *
 * Reordenar ofertas é composição (PATCH /composition `offerOrder`).
 */
@Injectable()
export class McOfferCarouselService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly quality: McQualityService,
  ) {}

  /** PATCH /projects/:id/offers/:offerId */
  async updateOffer(
    userId: string,
    projectId: string,
    offerId: string,
    dto: UpdateOfferDto,
  ): Promise<(McProject & { offerLineProposal: McOfferLineProposal }) | McOfferLineProposal> {
    const project = await this.carouselProject(userId, projectId);
    const script = project.script as McScript;
    const offers = carouselOffers(script);
    const offer = offers.find((o) => o.id === offerId);
    if (!offer) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Oferta não encontrada neste vídeo.',
        details: { offerId },
      });
    }
    const next: McSealProduct = { ...offer };
    if (dto.name !== undefined) next.name = dto.name.trim();
    if (dto.price !== undefined) {
      const price = carouselPrice(dto.price);
      if (!price) {
        throw new HttpException(
          {
            code: 'OFFER_PRICE_INVALID',
            message: `Preço "${dto.price}" ilegível (use o formato 24,90).`,
            details: { offerId },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      next.price = price;
    }
    if (dto.imageUrl !== undefined) next.imageUrl = dto.imageUrl;
    if (dto.badge !== undefined) next.badge = dto.badge;
    if (dto.unit !== undefined) next.unit = dto.unit;
    if (dto.originalPrice !== undefined) {
      next.originalPrice = dto.originalPrice === null ? null : carouselPrice(dto.originalPrice);
      if (dto.originalPrice !== null && !next.originalPrice) {
        throw new HttpException(
          {
            code: 'OFFER_PRICE_INVALID',
            message: `Preço anterior "${dto.originalPrice}" ilegível (use o formato 24,90).`,
            details: { offerId },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    const before = canonicalProduct(offer);
    const after = canonicalProduct(next);
    const changed = Object.keys(after).filter(
      (key) => key !== 'price' && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (!samePrice(offer.price, next.price)) changed.push('price');
    const spoken = changed.includes('name') || changed.includes('price');
    const scene = script.scenes.find((s) => s.productRef === offerId) ?? null;
    const previousDialogue = scene?.dialogue ?? null;
    const confirmed = dto.dialogue?.replace(/\s+/g, ' ').trim() || null;
    const dialogueChanged =
      !!confirmed && confirmed !== (previousDialogue ?? '').replace(/\s+/g, ' ').trim();
    if (changed.length === 0 && !dialogueChanged) {
      throw new HttpException(
        { code: 'NO_OFFER_CHANGE', message: 'Nada mudou nesta oferta.', details: { offerId } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const speech = spoken || dialogueChanged;
    const proposal: McOfferLineProposal = {
      offerId,
      sceneId: scene?.sceneId ?? null,
      previousDialogue,
      proposedDialogue: speech ? (confirmed ?? buildOfferLineText(next)) : previousDialogue,
      scope: speech ? 'speech' : 'composition',
      changed: dialogueChanged ? [...changed, 'dialogue'] : changed,
    };
    if (dto.dryRun) return proposal;

    const quality = resolveQuality(project.quality);
    const delivered =
      project.status === McProjectStatus.SUCCEEDED ||
      (project.status === McProjectStatus.VISUAL_REVIEW &&
        quality.pendingScope === 'assembly_only');
    let updated: McProject;
    if (!speech && delivered) {
      // só composição depois da entrega: render + finalize (revisão assembly_only)
      updated = await this.quality.updateComposition(userId, projectId, {
        expectedRevision: dto.expectedRevision,
        offers: [
          {
            id: offerId,
            ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
            ...(dto.badge !== undefined ? { badge: dto.badge } : {}),
            ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
            ...(dto.originalPrice !== undefined ? { originalPrice: next.originalPrice } : {}),
          },
        ],
      });
    } else {
      updated = await this.quality.updateScript(
        userId,
        projectId,
        this.scriptDto(script, dto.expectedRevision, offers, next, {
          sceneId: speech ? (scene?.sceneId ?? null) : null,
          dialogue: proposal.proposedDialogue,
        }),
      );
    }
    return { ...updated, offerLineProposal: proposal };
  }

  /** POST /projects/:id/offers/:offerId/refresh — aplica o preço atual do catálogo (= troca de preço). */
  async refreshOfferFromCatalog(
    userId: string,
    projectId: string,
    offerId: string,
    expectedRevision: number,
  ): Promise<McProject & { offerLineProposal: McOfferLineProposal }> {
    const project = await this.carouselProject(userId, projectId);
    const offer = carouselOffers(project.script as McScript).find((o) => o.id === offerId);
    if (!offer) {
      throw new NotFoundException({
        code: 'OFFER_NOT_FOUND',
        message: 'Oferta não encontrada neste vídeo.',
        details: { offerId },
      });
    }
    if (!isUuid(offer.catalogId)) {
      throw new HttpException(
        {
          code: 'OFFER_WITHOUT_CATALOG',
          message: 'Esta oferta não veio do catálogo — edite o preço diretamente.',
          details: { offerId },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const product = await this.dataSource
      .getRepository(Product)
      .findOne({ where: { id: offer.catalogId as string, active: true } });
    const catalogPrice = product ? formatOfferPrice(product.price) : null;
    if (!product || !catalogPrice) {
      throw new HttpException(
        {
          code: 'CATALOG_PRODUCT_NOT_FOUND',
          message: 'O produto desta oferta não está mais ativo no catálogo.',
          details: { offerId, catalogId: offer.catalogId },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (samePrice(catalogPrice, offer.price)) {
      throw new HttpException(
        {
          code: 'CATALOG_PRICE_UNCHANGED',
          message: 'O preço do catálogo é o mesmo do vídeo.',
          details: { offerId, price: offer.price },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return (await this.updateOffer(userId, projectId, offerId, {
      expectedRevision,
      price: catalogPrice,
    })) as McProject & { offerLineProposal: McOfferLineProposal };
  }

  /** Ofertas do vídeo com preço de catálogo diferente do congelado (ver `offersCatalogChanges`). */
  catalogChanges(project: Pick<McProject, 'format' | 'script'>): Promise<McOfferCatalogChange[]> {
    return offersCatalogChanges(this.dataSource, project);
  }

  // ─────────────────────────────── internos ───────────────────────────────

  private async carouselProject(userId: string, projectId: string): Promise<McProject> {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado' });
    }
    if (project.userId !== userId) throw new ForbiddenException();
    if (
      project.format !== 'offer_carousel' ||
      !isPipelineV2(project) ||
      !project.script ||
      !isScriptV2(project.script)
    ) {
      throw new HttpException(
        {
          code: 'FORMAT_NOT_OFFER_CAROUSEL',
          message: 'Esta ação só existe em vídeos "ofertas em sequência".',
          details: { format: project.format },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return project;
  }

  /** O roteiro atual como DTO do PATCH script, com a oferta corrigida e (opcional) a fala nova. */
  private scriptDto(
    script: McScript,
    expectedRevision: number,
    offers: McSealProduct[],
    next: McSealProduct,
    line: { sceneId: string | null; dialogue: string | null },
  ): UpdateScriptV2Dto {
    return {
      expectedRevision,
      offers: offers.map((o) => {
        const value = o.id === next.id ? next : o;
        return {
          id: value.id,
          catalogId: value.catalogId ?? null,
          unit: value.unit ?? null,
          name: value.name,
          price: value.price,
          imageUrl: value.imageUrl ?? null,
          originalPrice: value.originalPrice ?? null,
          badge: value.badge ?? null,
        };
      }),
      scenes: script.scenes.map((s) => {
        const rewrite = line.sceneId && s.sceneId === line.sceneId && line.dialogue;
        return {
          sceneId: s.sceneId,
          sceneType: s.sceneType as McSceneType,
          initialFrame: s.initialFrame,
          actionPrompt: s.actionPrompt,
          dialogue: rewrite ? line.dialogue : s.dialogue,
          durationS: rewrite ? plannedTalkDurationS(line.dialogue as string) : s.durationS,
          productRef: s.productRef ?? null,
          sealCue: s.sealCue ?? null,
          safeArea: s.safeArea ?? null,
          camera: s.camera ?? null,
          environmentId: s.environmentId ?? null,
        };
      }),
    };
  }
}
