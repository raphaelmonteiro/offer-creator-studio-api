import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as sharp from 'sharp';
import { DataSource, In } from 'typeorm';
import { Client } from '../../clients/entities/client.entity';
import { FlyerBuilderV2Document } from '../../flyer-builder-v2/entities/flyer-builder-v2-document.entity';
import { Flyer } from '../../flyers/entities/flyer.entity';
import { Mascot } from '../../mascots/entities/mascot.entity';
import { Product } from '../../products/entities/product.entity';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { CommercialsService } from '../commercials.service';
import {
  computeSnapshotHash,
  extractOffers,
  McArtOffer,
  McArtOffersError,
  selectOffers,
  sourcePageCount,
} from '../domain/mc-art-offers';
import {
  confirmLogoBox,
  McLogoBoxAction,
  McLogoBoxSource,
  McLogoLocatorResult,
  McProjectLogoBox,
  logoBoxActions,
  readProjectLogoBox,
  resolveLogoBox,
  sampleLogoBoxSurroundColor,
  validateLogoBoxInArt,
} from '../domain/mc-logo-face';
import { assertFormatEnabled, assertPipelineV2ForFormat } from '../domain/mc-pipeline.config';
import { McProjectStatus } from '../domain/mc-state-machines';
import {
  MC_DEFAULT_PROJECT_TIER,
  McAspectRatio,
  McLogoBox,
  McProjectFormat,
  McSealProduct,
  McSourceArt,
  McSourceArtKind,
} from '../domain/mc-types';
import { CreateProjectDto, ProjectProductDto } from '../dto/create-project.dto';
import { CreateProjectFromArtDto, FromArtOfferDto } from '../dto/from-art.dto';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McArtService } from './mc-art.service';
import { McKitView, McKitViewService } from './mc-kit-view.service';
import { McLogoLocatorService } from './mc-logo-locator.service';
import { McStorageService } from './mc-storage.service';
import { McOfferCatalogChange, offersCatalogChanges } from './mc-offer-carousel.service';

/** Duração alvo default por formato (F1: apresentação de 6 a 25 s; F2: ≤ 30 s estimados). */
export const MC_FROM_ART_DEFAULT_DURATION_S: Record<'talking_art' | 'offer_carousel', number> = {
  talking_art: 15,
  offer_carousel: 25,
};

/** Arte de origem carregada do banco, já com a forma do jsonb resolvida. */
export interface McArtSource {
  kind: McSourceArtKind;
  id: string;
  name: string;
  clientId: string | null;
  /** `flyers.configuration` ou `flyer_builder_v2_documents.document`. */
  payload: unknown;
  pageCount: number;
}

/** Resposta de GET /commercials/art-sources/:kind/:id/offers. */
export interface McArtOffersView {
  sourceKind: McSourceArtKind;
  sourceId: string;
  name: string;
  clientId: string | null;
  pageIndex: number;
  pageCount: number;
  offers: McArtOffer[];
}

/** Resposta de GET /commercials/kits/suggest?clientId=. */
export interface McKitSuggestion {
  clientId: string;
  /** Kit sugerido: o último usado para este cliente, senão o aprovado mais recente. */
  kit: McKitView | null;
  /** Demais kits aprovados do cliente, mais recentes primeiro. */
  alternatives: McKitView[];
  /** Kit do projeto mais recente do usuário com um kit deste cliente (null = nunca usou). */
  lastUsedKitId: string | null;
  /** Sem kit: o fluxo pode criar um a partir do logo cadastrado do cliente (D5). */
  canCreateFromLogo: boolean;
  clientLogoUrl: string | null;
}

/** Campos acrescentados a GET /commercials/projects/:id (tarefa 5.5). */
export interface McSourceArtStatus {
  sourceArt: McSourceArt | null;
  /** A arte/encarte de origem mudou (ofertas) ou sumiu depois da criação do projeto. */
  sourceArtChanged: boolean;
  /** A origem não existe mais (apagada) — `sourceArtChanged` também é true. */
  sourceArtMissing: boolean;
}

/** Status em que a caixa do logo pode ser detectada/marcada (revisão do roteiro ou das prévias). */
export const MC_LOGO_BOX_EDITABLE_STATUSES: readonly McProjectStatus[] = [
  McProjectStatus.STORYBOARD_REVIEW,
  McProjectStatus.VISUAL_REVIEW,
];

/**
 * Resposta de POST /projects/:id/logo-box/detect e PUT /projects/:id/logo-box
 * (D9b, tarefa 4.6): a caixa GRAVADA no projeto e o que a UI deve oferecer.
 */
export interface McLogoBoxView {
  projectId: string;
  /** Caixa gravada (frações da arte + origem/confiança/confirmação); null = sem caixa. */
  logoBox: McProjectLogoBox | null;
  /** `layout` | `detected` | `user` | `none` (sem caixa: o usuário marca). */
  source: McLogoBoxSource;
  confidence: number | null;
  confirmed: boolean;
  /** `confirm_logo_box`/`mark_logo_box` (proposta) · `mark_logo_box`/`use_window` (sem caixa) · [] (pronta). */
  actions: McLogoBoxAction[];
  /**
   * Só na detecção: o que o localizador devolveu — inclusive a caixa de
   * confiança < 0,7, que serve de ponto de partida para a marcação, e `error`
   * quando a visão ficou indisponível.
   */
  detection: McLogoLocatorResult | null;
}

/** Produto do snapshot como `createProject` o recebe (+ catalogId/preço anterior preservados, D9). */
type FromArtProduct = ProjectProductDto &
  Pick<McSealProduct, 'catalogId' | 'originalPrice' | 'badge'>;

/**
 * Ponte arte → projeto (tarefas 5.3 a 5.6, design D9/D9b/D12/D13).
 *
 * `createFromArt` valida o asset da arte (`video_art` do usuário), carrega a
 * origem (`flyers.configuration` para o encarte legado; `document` do
 * documento V2 para o encarte V2 e a arte social), extrai as ofertas da
 * página, aplica a seleção por formato (com imagem faltante resolvida pelo
 * catálogo), escolhe o kit (`kitId` ou o sugerido pelo cliente da arte) e
 * DELEGA a `CommercialsService.createProject` com o DTO estendido
 * (`format`, `tier`, `channel`, `backgroundArtAssetId`, `logoBox`,
 * `sourceArt.snapshotHash`, `aspectRatio` inferido e `products` congelados):
 * é lá que ficam o kill-switch, `admitProjectFormat`, o preflight de render,
 * a validação do asset de fundo, a do kit e a transação (mini-reserva, CAS,
 * step `script`, evento, notify).
 *
 * CAIXA DO LOGO (D9b, tarefa 4.6): `logoBox` da ponte é usada como está
 * (`layout`, confirmada); com `logoFace` e sem caixa, a criação roda o
 * localizador UMA vez e grava a proposta (≥ 0,7, não confirmada). Depois,
 * `detectLogoBox`/`setLogoBox` (revisão do roteiro ou das prévias) detectam
 * de novo ou gravam a marcação do usuário — sempre dentro do jsonb `logoBox`.
 *
 * OWNERSHIP DA ORIGEM: `flyers`, `flyer_builder_v2_documents`, `clients` e
 * `products` não têm coluna de dono neste código (FlyersService.findOne e
 * FlyerBuilderV2Service.findOne buscam só por id) — a ponte segue a mesma
 * regra: o JWT dá acesso a qualquer arte. O asset da arte e o kit, sim, são
 * do usuário (404/403).
 */
@Injectable()
export class McFromArtService {
  private readonly logger = new Logger(McFromArtService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly commercials: CommercialsService,
    private readonly art: McArtService,
    private readonly kitView: McKitViewService,
    private readonly locator: McLogoLocatorService,
    private readonly storage: McStorageService,
  ) {}

  // ───────────────────────────── origem e ofertas ─────────────────────────────

  /**
   * `flyer` → linha de `flyers` (configuration). `v2_document` → documento V2.
   * `social` → documento V2 com `documentKind = 'social'` (é de onde `/social`
   * lista) e, na falta, uma linha de `flyers` com `kind = 'social'` (fluxo
   * social antigo). 404 SOURCE_NOT_FOUND quando nada existe.
   */
  async loadSource(kind: McSourceArtKind, id: string): Promise<McArtSource> {
    if (kind === 'flyer' || kind === 'social') {
      if (kind === 'social') {
        const doc = await this.dataSource.getRepository(FlyerBuilderV2Document).findOne({
          where: { id },
        });
        if (doc) return McFromArtService.fromV2Document(kind, doc);
      }
      const flyer = await this.dataSource.getRepository(Flyer).findOne({ where: { id } });
      if (flyer && (kind === 'flyer' || flyer.kind === 'social')) {
        return {
          kind,
          id: flyer.id,
          name: flyer.name,
          clientId: flyer.clientId ?? null,
          payload: flyer.configuration,
          pageCount: sourcePageCount(flyer.configuration),
        };
      }
    } else {
      const doc = await this.dataSource.getRepository(FlyerBuilderV2Document).findOne({
        where: { id },
      });
      if (doc) return McFromArtService.fromV2Document(kind, doc);
    }
    throw new NotFoundException({
      code: 'SOURCE_NOT_FOUND',
      message: 'Arte de origem não encontrada.',
      details: { sourceKind: kind, sourceId: id },
    });
  }

  private static fromV2Document(kind: McSourceArtKind, doc: FlyerBuilderV2Document): McArtSource {
    return {
      kind,
      id: doc.id,
      name: doc.name,
      clientId: doc.clientId ?? null,
      payload: doc.document,
      pageCount: sourcePageCount(doc.document),
    };
  }

  /** Ofertas da página, com os ids que a seleção de `from-art` referencia. */
  async listOffers(kind: McSourceArtKind, id: string, pageIndex = 0): Promise<McArtOffersView> {
    const source = await this.loadSource(kind, id);
    const offers = this.extract(source, pageIndex);
    return {
      sourceKind: kind,
      sourceId: source.id,
      name: source.name,
      clientId: source.clientId,
      pageIndex,
      pageCount: source.pageCount,
      offers,
    };
  }

  private extract(source: McArtSource, pageIndex: number): McArtOffer[] {
    try {
      return extractOffers(source.payload, pageIndex);
    } catch (err) {
      throw McFromArtService.toHttp(err);
    }
  }

  /** Regra de negócio do domínio → 422 com código (convenção D13). */
  private static toHttp(err: unknown): unknown {
    if (err instanceof McArtOffersError) {
      return new HttpException(
        { code: err.code, message: err.message, details: err.details },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return err;
  }

  // ───────────────────────────── criação (5.3/5.4) ─────────────────────────────

  async createFromArt(userId: string, dto: CreateProjectFromArtDto): Promise<McProject> {
    const format: McProjectFormat = dto.format;
    // Gates puros ANTES de qualquer leitura (D13): formato admitido e executor
    // v2 obrigatório para F1/F2. `createProject` repete a admissão (barato) e
    // acrescenta kill-switch, preflight de render e validação do asset/kit.
    assertFormatEnabled(format);
    assertPipelineV2ForFormat(format);

    const asset = await this.art.findOwned(userId, dto.artAssetId);
    const aspectRatio: McAspectRatio = McArtService.aspectRatioOf(asset);

    const pageIndex = dto.pageIndex ?? 0;
    const source = await this.loadSource(dto.sourceKind, dto.sourceId);
    const offers = this.extract(source, pageIndex);
    const selected = await this.selectWithCatalog(format, offers, dto.offers);
    const kitId = dto.kitId ?? (await this.suggestedKitIdOrThrow(userId, source.clientId));
    // D9b: (a) caixa do layout como está; (b/c) com `logoFace` e sem caixa,
    // UMA detecção — proposta ≥ 0,7 gravada sem confirmação, senão sem caixa.
    // F1: a caixa leva a cor da arte em volta (cor da janela no rosto do logo).
    const resolvedLogoBox = dto.logoBox
      ? resolveLogoBox({ layoutBox: dto.logoBox }).logoBox
      : dto.logoFace === true && format === 'talking_art'
        ? await this.proposeLogoBox(userId, kitId, asset)
        : null;
    const logoBox =
      format === 'talking_art'
        ? await this.withSurroundColor(
            resolvedLogoBox,
            asset.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null,
          )
        : resolvedLogoBox;

    const sourceArt: McSourceArt = {
      kind: dto.sourceKind,
      id: source.id,
      pageIndex,
      snapshotHash: computeSnapshotHash(offers, asset.id),
    };
    const products: FromArtProduct[] = selected.map((o) => ({
      name: o.name,
      price: o.price,
      unit: o.unit,
      imageUrl: o.imageUrl,
      catalogId: o.catalogId,
      originalPrice: o.originalPrice,
      // F2: selo do card congelado com a oferta (6.6); ausente = sem badge.
      ...(o.badge ? { badge: o.badge } : {}),
    }));

    const createDto: CreateProjectDto = {
      kitId,
      title: (dto.title?.trim() || `${source.name} — vídeo`).slice(0, 120),
      briefing: dto.briefing?.trim() || McFromArtService.defaultBriefing(source, selected),
      aspectRatio,
      targetDurationS: dto.targetDurationS ?? MC_FROM_ART_DEFAULT_DURATION_S[format],
      products,
      format,
      tier: dto.tier ?? MC_DEFAULT_PROJECT_TIER,
      channel: dto.channel,
      backgroundArtAssetId: asset.id,
      musicEnabled: dto.musicEnabled ?? false,
      ...(dto.layoutPreset ? { layoutPreset: dto.layoutPreset } : {}),
      logoBox: logoBox ?? undefined,
      sourceArt,
    };
    return this.commercials.createProject(userId, createDto);
  }

  /**
   * Seleção por formato com a resolução de imagem faltante pelo CATÁLOGO
   * (`products.imageUrl` da oferta com `catalogId`); a galeria entra pelo
   * `imageUrl` enviado na seleção (o front escolhe). Só URLs em /uploads/*.
   */
  private async selectWithCatalog(
    format: McProjectFormat,
    offers: McArtOffer[],
    selection: FromArtOfferDto[] | undefined,
  ): Promise<McArtOffer[]> {
    const candidates = selection?.length
      ? offers.filter((o) => selection.some((s) => s.id === o.id))
      : offers;
    const catalogIds = [
      ...new Set(
        candidates
          .filter((o) => !o.imageUrl && o.catalogId)
          .map((o) => o.catalogId as string)
          .filter((id) => McFromArtService.isUuid(id)),
      ),
    ];
    const catalogImages = new Map<string, string>();
    if (catalogIds.length > 0) {
      const products = await this.dataSource.getRepository(Product).find({
        where: { id: In(catalogIds), active: true },
        select: ['id', 'imageUrl'],
      });
      for (const p of products) {
        if (p.imageUrl && p.imageUrl.includes('/uploads/')) catalogImages.set(p.id, p.imageUrl);
      }
    }
    try {
      return selectOffers(format, offers, selection, (offer) =>
        offer.catalogId ? (catalogImages.get(offer.catalogId) ?? null) : null,
      );
    } catch (err) {
      throw McFromArtService.toHttp(err);
    }
  }

  private static isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  /** Sem `kitId`: o kit sugerido do cliente da arte; sem nenhum → 422 KIT_REQUIRED (5.6). */
  private async suggestedKitIdOrThrow(userId: string, clientId: string | null): Promise<string> {
    const suggestion = clientId ? await this.suggestKit(userId, clientId) : null;
    if (suggestion?.kit) return suggestion.kit.id;
    throw new HttpException(
      {
        code: 'KIT_REQUIRED',
        message: clientId
          ? suggestion?.canCreateFromLogo
            ? 'O cliente desta arte ainda não tem kit de personagem aprovado. Crie um a partir do logo do cliente (ou de um mascote) e tente de novo.'
            : 'O cliente desta arte ainda não tem kit de personagem aprovado. Crie um kit (mascote ou logo) e tente de novo.'
          : 'A arte não tem cliente vinculado: escolha o kit (kitId) ao criar o vídeo.',
        details: {
          clientId,
          canCreateFromLogo: suggestion?.canCreateFromLogo ?? false,
          clientLogoUrl: suggestion?.clientLogoUrl ?? null,
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private static defaultBriefing(source: McArtSource, offers: McArtOffer[]): string {
    const list = offers
      .slice(0, 6)
      .map((o) => `${o.name} por R$ ${o.price}${o.unit ? ` (${o.unit})` : ''}`)
      .join('; ');
    const text = list
      ? `Apresentar a arte "${source.name}" com as ofertas: ${list}.`
      : `Apresentar a arte "${source.name}" convidando o público a conferir as ofertas.`;
    return text.slice(0, 2000);
  }

  // ───────────────────────── arte de origem alterada (5.5) ─────────────────────────

  /**
   * Reextrai as ofertas da origem ATUAL e compara o hash com o congelado
   * (barato: uma leitura por chamada, sem cache). Origem apagada ou página
   * que não existe mais contam como "alterada".
   */
  async sourceArtStatus(
    project: Pick<McProject, 'sourceArt' | 'backgroundArtAssetId'>,
  ): Promise<McSourceArtStatus> {
    const sourceArt = project.sourceArt ?? null;
    if (!sourceArt) return { sourceArt: null, sourceArtChanged: false, sourceArtMissing: false };
    let source: McArtSource;
    try {
      source = await this.loadSource(sourceArt.kind, sourceArt.id);
    } catch (err) {
      if (err instanceof NotFoundException) {
        return { sourceArt, sourceArtChanged: true, sourceArtMissing: true };
      }
      throw err;
    }
    let offers: McArtOffer[];
    try {
      offers = extractOffers(source.payload, sourceArt.pageIndex);
    } catch (err) {
      if (err instanceof McArtOffersError) {
        return { sourceArt, sourceArtChanged: true, sourceArtMissing: false };
      }
      throw err;
    }
    const current = computeSnapshotHash(offers, project.backgroundArtAssetId ?? '');
    return {
      sourceArt,
      sourceArtChanged: current !== sourceArt.snapshotHash,
      sourceArtMissing: false,
    };
  }

  /**
   * Decora a visão do projeto (GET /commercials/projects/:id) com o status da
   * origem e, no F2, `offersCatalogChanged` (preço do catálogo mudou depois da
   * criação — tarefa 6.8). A comparação com o catálogo nunca derruba a leitura.
   */
  async withSourceArtStatus<T extends Pick<McProject, 'sourceArt' | 'backgroundArtAssetId'>>(
    view: T,
  ): Promise<T & McSourceArtStatus & { offersCatalogChanged: McOfferCatalogChange[] }> {
    let offersCatalogChanged: McOfferCatalogChange[] = [];
    try {
      offersCatalogChanged = await offersCatalogChanges(
        this.dataSource,
        view as unknown as Pick<McProject, 'format' | 'script'>,
      );
    } catch (err) {
      this.logger.warn(`Catálogo indisponível para comparar ofertas: ${(err as Error).message}`);
    }
    return { ...view, ...(await this.sourceArtStatus(view)), offersCatalogChanged };
  }

  // ───────────────────────── caixa do logo (D9b, tarefa 4.6) ─────────────────────────

  /**
   * POST /projects/:id/logo-box/detect — camada (b) sob demanda: localiza o
   * logo do kit na arte do projeto. Proposta (≥ 0,7) substitui a caixa
   * gravada, NÃO confirmada; "não localizado" só descarta proposta não
   * confirmada — nunca apaga a caixa do layout ou a marcada pelo usuário.
   */
  async detectLogoBox(userId: string, projectId: string): Promise<McLogoBoxView> {
    const project = await this.findEditableProject(userId, projectId);
    const artPath = await this.artPathOrThrow(userId, project.backgroundArtAssetId);
    const logoPath = await this.kitLogoPathOrThrow(userId, project.kitId);
    const detection = await this.locator.locate(artPath, logoPath);
    const resolution = resolveLogoBox({ detection });
    const current = readProjectLogoBox(project.logoBox);
    const next = await this.withSurroundColor(
      resolution.logoBox ?? (current?.logoBoxConfirmed ? current : null),
      artPath,
    );
    await this.writeLogoBox(project, next);
    return McFromArtService.logoBoxView(project.id, next, detection);
  }

  /**
   * PUT /projects/:id/logo-box — o usuário marca (ou confirma) a caixa:
   * inteira dentro da arte e com lado ≥ 2% (422 LOGO_BOX_OUT_OF_BOUNDS /
   * LOGO_BOX_TOO_SMALL). Repetir a proposta confirma a detecção; outra caixa
   * vira `user`. Sempre `logoBoxConfirmed: true`.
   */
  async setLogoBox(userId: string, projectId: string, box: McLogoBox): Promise<McLogoBoxView> {
    const project = await this.findEditableProject(userId, projectId);
    if (!project.backgroundArtAssetId) throw McFromArtService.artMissing();
    const issue = validateLogoBoxInArt(box);
    if (issue) {
      throw new HttpException(
        { code: issue.code, message: issue.message, details: issue.details },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const artPath = await this.artPathOrThrow(userId, project.backgroundArtAssetId);
    const next = await this.withSurroundColor(
      confirmLogoBox(readProjectLogoBox(project.logoBox), box),
      artPath,
    );
    await this.writeLogoBox(project, next);
    return McFromArtService.logoBoxView(project.id, next, null);
  }

  /** Detecção da criação (`logoFace` sem caixa): nunca bloqueia a criação — falha = sem caixa. */
  private async proposeLogoBox(
    userId: string,
    kitId: string,
    asset: AnimationAsset,
  ): Promise<McProjectLogoBox | null> {
    try {
      const artPath = asset.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null;
      if (!artPath) return null;
      const logoPath = await this.kitLogoPathOrThrow(userId, kitId);
      const detection = await this.locator.locate(artPath, logoPath);
      return resolveLogoBox({ detection }).logoBox;
    } catch (err) {
      this.logger.warn(
        `Rosto do logo: detecção pulada na criação (${(err as Error)?.message ?? err}) — o usuário marca a caixa.`,
      );
      return null;
    }
  }

  /** Projeto do usuário (404/403) em revisão do roteiro ou das prévias (senão 422 PROJECT_NOT_EDITABLE). */
  private async findEditableProject(userId: string, projectId: string): Promise<McProject> {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado' });
    }
    if (project.userId !== userId) throw new ForbiddenException();
    if (!MC_LOGO_BOX_EDITABLE_STATUSES.includes(project.status)) {
      throw McFromArtService.notEditable(project.status);
    }
    return project;
  }

  private static notEditable(status: McProjectStatus | null): HttpException {
    return new HttpException(
      {
        code: 'PROJECT_NOT_EDITABLE',
        message:
          'A caixa do logo só pode ser detectada ou marcada na revisão do roteiro ou das prévias.',
        details: { status, allowed: [...MC_LOGO_BOX_EDITABLE_STATUSES] },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private static artMissing(): HttpException {
    return new HttpException(
      {
        code: 'LOGO_BOX_ART_MISSING',
        message:
          'Este projeto não tem a arte de fundo no servidor — a caixa do logo só existe em vídeos criados a partir de uma arte.',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  /** Arte de fundo do projeto (asset `video_art` do usuário) → caminho no bucket. */
  private async artPathOrThrow(userId: string, assetId: string | null): Promise<string> {
    if (!assetId) throw McFromArtService.artMissing();
    const asset = await this.art.findOwned(userId, assetId);
    const artPath = asset.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null;
    if (!artPath) throw McFromArtService.artMissing();
    return artPath;
  }

  /**
   * Logo do kit (referência da detecção): o logo enviado do mascote `logo`
   * do kit (recorte quando houver — o mesmo arquivo que o `logo_as_is` copia
   * como identidade). Kit de mascote → 422 KIT_NOT_LOGO.
   */
  private async kitLogoPathOrThrow(userId: string, kitId: string): Promise<string> {
    const kit = await this.dataSource
      .getRepository(McCharacterKit)
      .findOne({ where: { id: kitId, userId } });
    if (!kit) throw new NotFoundException({ code: 'KIT_NOT_FOUND', message: 'Kit não encontrado' });
    if (kit.source !== 'logo') {
      throw new HttpException(
        {
          code: 'KIT_NOT_LOGO',
          message:
            'A detecção usa o logo do kit, e este kit é de mascote. Marque a caixa do logo na prévia ou use uma janela comum.',
          details: { kitId: kit.id, actions: ['mark_logo_box', 'use_window'] },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const mascot = await this.dataSource
      .getRepository(Mascot)
      .findOne({ where: { id: kit.mascotId, userId } });
    const url = mascot?.cutoutUrl ?? mascot?.sourceImageUrl ?? null;
    const logoPath = url ? this.storage.absoluteFromUrl(url) : null;
    if (!logoPath) {
      throw new HttpException(
        {
          code: 'KIT_LOGO_MISSING',
          message:
            'A imagem do logo do kit não foi encontrada no servidor. Marque a caixa na prévia.',
          details: { kitId: kit.id, actions: ['mark_logo_box', 'use_window'] },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return logoPath;
  }

  /**
   * A caixa com a cor da arte EM VOLTA dela (`surroundColor`), amostrada a
   * cada gravação — mover a caixa muda a cor. É a cor da janela no modo rosto
   * do logo (spec video-talking-art). Falha de leitura nunca bloqueia: fica
   * `null` e vale o fundo do tile do kit.
   */
  private async withSurroundColor(
    box: McProjectLogoBox | null,
    artPath: string | null,
  ): Promise<McProjectLogoBox | null> {
    if (!box) return null;
    if (!artPath) return { ...box, surroundColor: null };
    try {
      const { data, info } = await sharp(artPath).raw().toBuffer({ resolveWithObject: true });
      const surroundColor = sampleLogoBoxSurroundColor(
        { data, width: info.width, height: info.height, channels: info.channels },
        box,
      );
      return { ...box, surroundColor };
    } catch (err) {
      this.logger.warn(
        `Rosto do logo: cor em volta da caixa não amostrada (${(err as Error)?.message ?? err}) — vale a cor do kit.`,
      );
      return { ...box, surroundColor: null };
    }
  }

  /** Escrita condicionada ao status (CAS): mudou de fase no meio do caminho → 422 PROJECT_NOT_EDITABLE. */
  private async writeLogoBox(project: McProject, next: McProjectLogoBox | null): Promise<void> {
    const result = await this.dataSource
      .getRepository(McProject)
      .update(
        { id: project.id, userId: project.userId, status: In([...MC_LOGO_BOX_EDITABLE_STATUSES]) },
        { logoBox: next },
      );
    if (!result.affected) throw McFromArtService.notEditable(null);
    project.logoBox = next;
  }

  private static logoBoxView(
    projectId: string,
    box: McProjectLogoBox | null,
    detection: McLogoLocatorResult | null,
  ): McLogoBoxView {
    return {
      projectId,
      logoBox: box,
      source: box ? box.logoBoxSource : 'none',
      confidence: box ? box.logoBoxConfidence : (detection?.confidence ?? null),
      confirmed: !!box?.logoBoxConfirmed,
      actions: logoBoxActions(box),
      detection,
    };
  }

  // ───────────────────────────── kit sugerido (5.6) ─────────────────────────────

  /**
   * Kits aprovados do usuário cujo mascote (ou logo registrado como mascote)
   * pertence ao cliente, com o ÚLTIMO USADO primeiro. "Último usado" é
   * derivado de `mc_projects` (projeto mais recente do usuário com um kit do
   * cliente) — sem coluna nova nem setting: o próprio projeto é o registro
   * durável da escolha. `canCreateFromLogo` = o cliente tem `logoUrl`.
   */
  async suggestKit(userId: string, clientId: string): Promise<McKitSuggestion> {
    const client = await this.dataSource.getRepository(Client).findOne({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException({ code: 'CLIENT_NOT_FOUND', message: 'Cliente não encontrado' });
    }
    const mascots = await this.dataSource.getRepository(Mascot).find({
      where: { userId, clientId },
      select: ['id'],
    });
    const mascotIds = mascots.map((m) => m.id);
    const kits =
      mascotIds.length > 0
        ? await this.dataSource.getRepository(McCharacterKit).find({
            where: { userId, status: McKitStatus.APPROVED, mascotId: In(mascotIds) },
            order: { approvedAt: 'DESC', createdAt: 'DESC' },
          })
        : [];
    let lastUsedKitId: string | null = null;
    if (kits.length > 0) {
      const lastProject = await this.dataSource.getRepository(McProject).findOne({
        where: { userId, kitId: In(kits.map((k) => k.id)) },
        order: { createdAt: 'DESC' },
        select: ['id', 'kitId', 'createdAt'],
      });
      lastUsedKitId = lastProject?.kitId ?? null;
    }
    const ordered = lastUsedKitId
      ? [
          ...kits.filter((k) => k.id === lastUsedKitId),
          ...kits.filter((k) => k.id !== lastUsedKitId),
        ]
      : kits;
    const views = await Promise.all(ordered.map((kit) => this.kitView.toView(kit)));
    return {
      clientId,
      kit: views[0] ?? null,
      alternatives: views.slice(1),
      lastUsedKitId,
      canCreateFromLogo: Boolean(client.logoUrl),
      clientLogoUrl: client.logoUrl ?? null,
    };
  }
}
