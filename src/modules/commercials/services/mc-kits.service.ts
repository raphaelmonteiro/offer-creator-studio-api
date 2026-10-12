import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import OpenAI from 'openai';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ModerationProvider,
  ModerationResult,
} from '../../../shared/providers/moderation.provider';
import { sniffImageMime } from '../../../shared/providers/gemini-image.provider';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { ClientsService } from '../../clients/clients.service';
import { MascotsService, MascotView } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McVoicesService } from './mc-voices.service';
import { McKitSource } from '../domain/mc-kit-identity';
import {
  decideMouthGate,
  McKitMouthGate,
  McMouthDecision,
  McMouthVerdict,
} from '../domain/mc-mouth-gate';
import { sanitizeVoiceDeliveryOverride } from '../domain/mc-voice-delivery';
import {
  hasPtMirror,
  isKitReferenceSlot,
  KIT_TILE_BACKGROUND_DEFAULT,
  mergeTranslatedSheet,
  parseCanonicalDesc,
  type KitCanonicalDesc,
  type KitCanonicalDescPt,
  type KitSheetTranslation,
} from '../domain/kit-prompts';
import { assertKitTransition, McKitStatus } from '../domain/mc-state-machines';
import { CreateKitDto } from '../dto/create-kit.dto';
import { ApproveKitDto, RegenerateReferenceDto, UpdateKitSheetDto } from '../dto/kit-actions.dto';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { MC_IMAGE_EXPIRE_S, McKitCandidatesService } from './mc-kit-candidates.service';
import { McKitTileService } from './mc-kit-tile.service';
import { McKitView, McKitViewService } from './mc-kit-view.service';
import { McMouthGateService } from './mc-mouth-gate.service';
import { McStorageService } from './mc-storage.service';

export { MC_IMAGE_EXPIRE_S } from './mc-kit-candidates.service';
export type { KitReferenceView, McKitView } from './mc-kit-view.service';

/**
 * Fluxo REAL do kit do personagem (plano §4), substituindo o stub da Fase 0:
 * mascote validado via MascotsService (import permitido pelo boundary — só
 * animations↔commercials é proibido), moderação da imagem ANTES de gastar
 * (§6.8) e geração das referências no worker via fila mc.image.
 *
 * CRÉDITOS: o kit NÃO reserva créditos na v0 — o custo (~US$1–3/mascote,
 * plano §4) é absorvido como custo de onboarding; por isso a falha de geração
 * não tem estorno (não há o que estornar). A cobrança do kit entra, se
 * entrar, junto com a revisão de pricing do go-live.
 *
 * Change video-formatos-personagem: origem logo passa por candidatos
 * (McKitCandidatesService), e a aprovação roda o gate de boca e gera o tile
 * (McMouthGateService / McKitTileService).
 */
@Injectable()
export class McKitsService {
  private readonly logger = new Logger(McKitsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly queue: AnimationQueueService,
    private readonly mascots: MascotsService,
    private readonly moderation: ModerationProvider,
    private readonly commercials: CommercialsService,
    private readonly voices: McVoicesService,
    private readonly config: ConfigService,
    private readonly clients: ClientsService,
    private readonly view: McKitViewService,
    private readonly candidates: McKitCandidatesService,
    private readonly mouthGate: McMouthGateService,
    private readonly tile: McKitTileService,
    private readonly storage: McStorageService,
  ) {}

  /**
   * Cria o kit por ORIGEM (D5): `mascot` valida o mascote (existe, é do
   * usuário, direitos confirmados, imagem utilizável), modera a imagem e
   * enfileira a geração das referências — kit nasce 'generating' e o
   * McKitProcessor o leva a 'review'. `logo` registra o logo como personagem
   * de origem (linha de `mascots` com `kind = 'logo'`), exige os direitos da
   * marca e o estilo, modera, roda o gate de boca no logo cru (decide se
   * "usar como está" existe) e abre a PRIMEIRA rodada de candidatos (D4):
   * nenhuma referência antes da escolha.
   */
  async createKit(userId: string, dto: CreateKitDto): Promise<McCharacterKit> {
    const source: McKitSource = dto.source ?? 'mascot';
    const mascot =
      source === 'logo'
        ? await this.resolveLogoSource(userId, dto)
        : await this.resolveMascotSource(userId, dto);
    // Estilo é exigido para GERAR (spec "Estilo não escolhido"): referências
    // na origem mascote, candidatos na origem logo — ambos começam aqui.
    if (!dto.style) throw this.styleRequired();

    const imageUrl = mascot.cutoutUrl ?? mascot.sourceImageUrl;
    if (!imageUrl) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_IMAGE_REQUIRED',
        message:
          'Este mascote não tem imagem utilizável. Envie o PNG do mascote ' +
          '(de preferência com fundo transparente) e tente de novo.',
      });
    }
    const imageBuffer = await this.storage.readUploadsFile(imageUrl);
    if (!imageBuffer) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_IMAGE_MISSING',
        message:
          'A imagem do mascote não foi encontrada no servidor. ' +
          'Envie o arquivo novamente na biblioteca de mascotes.',
      });
    }

    const moderation = await this.moderateImage(imageBuffer);
    const base = {
      userId,
      mascotId: mascot.id,
      source,
      style: dto.style,
      identityMode: 'generated' as const,
      voiceId: dto.voiceId ?? null,
      // Logo: cor pedida ou cinza claro (fundo liso dos candidatos e do tile);
      // mascote: só quando pedida (o prompt legado segue em "light gray").
      tileBackgroundColor:
        dto.tileBackgroundColor?.toUpperCase() ??
        (source === 'logo' ? KIT_TILE_BACKGROUND_DEFAULT : null),
      moderation: this.moderationJson(moderation),
      mouthGate: null as McKitMouthGate | null,
    };
    if (moderation.flagged) await this.rejectModerated(base, moderation);
    // Gate de boca no logo CRU (spec "Logo usado como está"): se passa, a
    // opção "usar como está" aparece ao lado dos candidatos.
    if (source === 'logo') base.mouthGate = { logo: await this.mouthGate.inspect(imageBuffer) };

    // Criação + enqueue na MESMA transação (pg-boss é Postgres): se o publish
    // falhar, o kit não fica órfão em 'generating' para sempre.
    return this.dataSource.transaction(async (manager) => {
      const kit = await manager
        .getRepository(McCharacterKit)
        .save({ ...base, status: McKitStatus.GENERATING });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: null,
        toStatus: McKitStatus.GENERATING,
        detail: {
          mascotId: mascot.id,
          source,
          style: dto.style,
          logoMouthGate: base.mouthGate?.logo ? decideMouthGate(base.mouthGate.logo) : null,
        },
      });
      if (source === 'mascot') {
        await this.queue.publish(
          QUEUES.MC_IMAGE,
          { kitId: kit.id },
          { expireInSeconds: MC_IMAGE_EXPIRE_S },
        );
      } else {
        const round = await this.candidates.openRound(manager, kit, { kind: 'mascotization' });
        kit.candidateRoundId = round.roundId;
      }
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.GENERATING },
        MC_EVENTS_CHANNEL,
      );
      return kit;
    });
  }

  /** Origem `mascot`: mascote do usuário (404/403 pelo MascotsService), do tipo certo e com direitos. */
  private async resolveMascotSource(userId: string, dto: CreateKitDto): Promise<MascotView> {
    if (!dto.mascotId) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_REQUIRED',
        message: 'Informe o mascote (mascotId) para criar o kit a partir de um mascote.',
      });
    }
    const mascot = await this.mascots.findOne(userId, dto.mascotId);
    if ((mascot.kind ?? 'mascot') !== 'mascot') {
      throw new UnprocessableEntityException({
        code: 'MASCOT_KIND_MISMATCH',
        message:
          'Este cadastro é um logo — para usá-lo como personagem, crie o kit com origem "logo" ' +
          'informando logoMascotId.',
      });
    }
    if (!mascot.rightsConfirmedAt) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_RIGHTS_REQUIRED',
        message:
          'Confirme a titularidade ou licença de uso do mascote antes de criar o kit — ' +
          'abra o mascote na biblioteca e aceite o termo de direitos.',
      });
    }
    return mascot;
  }

  /**
   * Origem `logo`: exatamente um de `clientId` (logo cadastrado do cliente →
   * `MascotsService.createFromUrl`, idempotente) ou `logoMascotId` (logo já
   * registrado, `kind = 'logo'`). A declaração de direitos da marca é a mesma
   * exigida do mascote; sem ela, 422 LOGO_RIGHTS_REQUIRED com o `mascotId`
   * do logo, para o cliente confirmar em `POST /mascots/:id/rights`.
   */
  private async resolveLogoSource(userId: string, dto: CreateKitDto): Promise<MascotView> {
    if (dto.clientId && dto.logoMascotId) {
      throw new UnprocessableEntityException({
        code: 'LOGO_SOURCE_AMBIGUOUS',
        message: 'Informe só um: clientId (logo do cliente) ou logoMascotId (logo já registrado).',
      });
    }
    if (!dto.clientId && !dto.logoMascotId) {
      throw new UnprocessableEntityException({
        code: 'LOGO_SOURCE_REQUIRED',
        message:
          'Para criar o kit a partir de um logo, informe clientId (logo cadastrado do cliente) ' +
          'ou logoMascotId (logo já registrado).',
      });
    }
    const mascot = dto.logoMascotId
      ? await this.mascots.findOne(userId, dto.logoMascotId)
      : await this.registerClientLogo(userId, dto.clientId as string, dto.rightsConfirmed === true);
    if (mascot.kind !== 'logo') {
      throw new UnprocessableEntityException({
        code: 'MASCOT_KIND_MISMATCH',
        message: 'O cadastro informado em logoMascotId não é um logo.',
      });
    }
    if (!mascot.rightsConfirmedAt) {
      throw new UnprocessableEntityException({
        code: 'LOGO_RIGHTS_REQUIRED',
        message:
          'Confirme que você tem o direito de uso da marca antes de criar o kit a partir do logo.',
        mascotId: mascot.id,
      });
    }
    return mascot;
  }

  /** Logo cadastrado do cliente (`clients.logoUrl`) → linha de `mascots` com `kind = 'logo'`. */
  private async registerClientLogo(
    userId: string,
    clientId: string,
    rightsConfirmed: boolean,
  ): Promise<MascotView> {
    // ClientsService.findOne já resolve 404 CLIENT_NOT_FOUND.
    const client = await this.clients.findOne(clientId);
    if (!client.logoUrl) {
      throw new UnprocessableEntityException({
        code: 'CLIENT_LOGO_REQUIRED',
        message:
          'Este cliente não tem logo cadastrado. Envie o logo na ficha do cliente ou ' +
          'registre o arquivo do logo diretamente.',
      });
    }
    return this.mascots.createFromUrl(userId, client.logoUrl, {
      name: `Logo ${client.name}`.slice(0, 120),
      clientId,
      kind: 'logo',
      rightsConfirmed,
    });
  }

  private styleRequired(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'STYLE_REQUIRED',
      message:
        'Escolha o estilo do personagem (cartoon_2d, 3d_render ou realistic) antes de gerar ' +
        'as referências do kit.',
    });
  }

  /**
   * Moderação ANTES de gastar com providers (plano §6.8). Indisponibilidade
   * do moderador BLOQUEIA a criação (fail-closed com erro acionável) — a
   * exceção é a ausência de OPENAI_API_KEY em dev, que vira `skipped`
   * auditado no jsonb.
   */
  private async moderateImage(imageBuffer: Buffer): Promise<ModerationResult> {
    try {
      return await this.moderation.moderate({
        imageBase64: imageBuffer.toString('base64'),
        imageMimeType: sniffImageMime(imageBuffer),
      });
    } catch (err) {
      this.logger.error(`Moderação indisponível: ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'MODERATION_UNAVAILABLE',
        message: 'Não foi possível verificar a imagem agora. Tente novamente em instantes.',
      });
    }
  }

  /**
   * Resultado auditado MESMO no bloqueio: o kit nasce 'failed' com o jsonb da
   * moderação — trilha do §6.8 sem gastar um centavo de geração.
   */
  private async rejectModerated(
    base: Pick<McCharacterKit, 'userId' | 'mascotId' | 'source' | 'style' | 'voiceId'> &
      Partial<McCharacterKit>,
    moderation: ModerationResult,
  ): Promise<never> {
    const blocked = await this.dataSource
      .getRepository(McCharacterKit)
      .save({ ...base, status: McKitStatus.FAILED });
    await this.dataSource.transaction(async (manager) => {
      await this.commercials.appendEvent(manager, {
        userId: base.userId,
        refKind: 'kit',
        refId: blocked.id,
        kind: 'moderation_blocked',
        toStatus: McKitStatus.FAILED,
        detail: { categories: moderation.categories },
      });
    });
    throw new UnprocessableEntityException({
      code: 'MASCOT_MODERATION_BLOCKED',
      message:
        'A imagem do mascote foi bloqueada pela verificação de conteúdo' +
        (moderation.categories.length > 0 ? ` (${moderation.categories.join(', ')})` : '') +
        '. Use outra imagem do personagem.',
    });
  }

  /**
   * review → approved (gate humano §4). Exige voz definida — aqui ou na
   * criação. Antes de aprovar (D1/D4): a identidade passa pelo gate de boca
   * (bloqueio 422 MOUTH_NOT_LEGIBLE; indeciso só com `acceptMouthRisk`, com a
   * decisão registrada no kit) e o tile é gerado a partir dela (recusa 422
   * TILE_BORDER_NOT_UNIFORM mantém o kit em revisão).
   */
  async approveKit(userId: string, id: string, dto: ApproveKitDto): Promise<McCharacterKit> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.REVIEW) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_IN_REVIEW',
        message: `O kit está em '${kit.status}' — só kits em revisão podem ser aprovados.`,
      });
    }
    const voiceInput = dto.voiceId ?? kit.voiceId;
    if (!voiceInput) {
      throw new UnprocessableEntityException({
        code: 'KIT_VOICE_REQUIRED',
        message:
          'Escolha a voz do mascote antes de aprovar o kit — ela é parte do personagem ' +
          '(ouça as opções em /commercials/voices e teste com o preview).',
      });
    }
    // Aceita id do catálogo OU providerVoiceId e grava SEMPRE o id real da
    // ElevenLabs — é ele que o TTS do pipeline usa direto (mesma correção do
    // preview: a UI envia o id da linha do catálogo). Escopado ao usuário
    // (D10): voz de outro dono ou invisível → 422 VOICE_NOT_IN_CATALOG.
    const voiceId = await this.voices.resolveProviderVoiceId(userId, voiceInput);
    // Ajuste de entrega: o que veio no body vence; sem body mantém o do kit.
    const voiceDelivery =
      dto.delivery !== undefined
        ? sanitizeVoiceDeliveryOverride(dto.delivery as Record<string, unknown>)
        : (kit.voiceDelivery ?? null);

    const identity = await this.resolveIdentity(kit);
    const { verdict, decision } = await this.identityMouthGate(kit, identity);
    const gateRecord: McKitMouthGate = {
      ...(kit.mouthGate ?? {}),
      identity: { ...verdict, identityAssetId: identity.id },
    };
    if (decision === 'blocked') {
      await this.persistMouthGate(kit.id, gateRecord);
      throw new UnprocessableEntityException({
        code: 'MOUTH_NOT_LEGIBLE',
        message:
          'A identidade do kit não tem boca legível para animar a fala. Gere uma variante ' +
          'com boca (ou escolha outro candidato) antes de aprovar.',
        details: { verdict, actions: ['mouth_variant', 'choose_candidate'] },
      });
    }
    if (decision === 'undecided') {
      if (dto.acceptMouthRisk !== true) {
        await this.persistMouthGate(kit.id, gateRecord);
        throw new UnprocessableEntityException({
          code: 'MOUTH_GATE_UNDECIDED',
          message:
            'Não foi possível confirmar que a boca do personagem é legível. Aprove assumindo ' +
            'o risco (acceptMouthRisk) ou gere uma variante com boca.',
          details: { verdict, actions: ['accept_mouth_risk', 'mouth_variant'] },
        });
      }
      gateRecord.riskAccepted = {
        at: new Date().toISOString(),
        identityAssetId: identity.id,
        confidence: verdict.confidence,
      };
    } else {
      delete gateRecord.riskAccepted;
    }
    const tile = await this.ensureTile(kit, identity, verdict, gateRecord);

    assertKitTransition(McKitStatus.REVIEW, McKitStatus.APPROVED);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.REVIEW,
        McKitStatus.APPROVED,
        {
          approvedAt: new Date(),
          voiceId,
          voiceDelivery,
          identityAssetId: identity.id,
          tileAssetId: tile.assetId,
          tileBackgroundColor: tile.backgroundColor,
          mouthGate: gateRecord,
        },
      );
      if (!won) {
        throw new UnprocessableEntityException({
          code: 'KIT_NOT_IN_REVIEW',
          message: 'O kit mudou de estado durante a aprovação. Recarregue e tente de novo.',
        });
      }
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.REVIEW,
        toStatus: McKitStatus.APPROVED,
        detail: {
          voiceId,
          voiceDelivery,
          identityAssetId: identity.id,
          tileAssetId: tile.assetId,
          tileBackgroundColor: tile.backgroundColor,
          mouthGate: decision,
          riskAccepted: decision === 'undecided',
        },
      });
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.APPROVED },
        MC_EVENTS_CHANNEL,
      );
    });
    return this.dataSource.getRepository(McCharacterKit).findOneByOrFail({ id: kit.id });
  }

  /** Identidade efetiva (candidato escolhido / logo como está / referência frontal) ou 422. */
  private async resolveIdentity(kit: McCharacterKit): Promise<AnimationAsset> {
    const identity = await this.view.resolveIdentityAsset(kit);
    if (!identity) {
      throw new UnprocessableEntityException({
        code: 'KIT_IDENTITY_MISSING',
        message:
          'O kit não tem identidade para o tile: regenere a referência frontal (slot 2) ' +
          'ou escolha um candidato.',
      });
    }
    return identity;
  }

  /** Veredito sobre a identidade: reaproveita o já gravado para o MESMO asset (sem repetir visão). */
  private async identityMouthGate(
    kit: McCharacterKit,
    identity: AnimationAsset,
  ): Promise<{ verdict: McMouthVerdict; decision: McMouthDecision }> {
    const cached = kit.mouthGate?.identity;
    if (cached && cached.identityAssetId === identity.id && !cached.error) {
      return { verdict: cached, decision: decideMouthGate(cached) };
    }
    const buffer = identity.fileUrl ? await this.storage.readUploadsFile(identity.fileUrl) : null;
    if (!buffer) {
      throw new UnprocessableEntityException({
        code: 'KIT_IDENTITY_FILE_MISSING',
        message:
          'A imagem da identidade do kit não foi encontrada no servidor. Escolha outra ' +
          'identidade ou regenere a referência frontal.',
      });
    }
    const verdict = await this.mouthGate.inspect(buffer);
    return { verdict, decision: decideMouthGate(verdict) };
  }

  /**
   * Tile da identidade: reaproveita o existente quando foi gerado para o
   * MESMO asset; senão gera (e grava o veredito antes, para a recusa da borda
   * não perder a avaliação de boca já paga).
   */
  private async ensureTile(
    kit: McCharacterKit,
    identity: AnimationAsset,
    verdict: McMouthVerdict,
    gateRecord: McKitMouthGate,
  ): Promise<{ assetId: string; backgroundColor: string | null }> {
    if (kit.tileAssetId) {
      const existing = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: kit.tileAssetId });
      if (existing && existing.metadata?.identityAssetId === identity.id) {
        const color = existing.metadata?.backgroundColor;
        return {
          assetId: existing.id,
          backgroundColor: typeof color === 'string' ? color : kit.tileBackgroundColor,
        };
      }
    }
    try {
      const built = await this.tile.build(kit, identity, verdict.bbox);
      return { assetId: built.assetId, backgroundColor: built.backgroundColor };
    } catch (err) {
      await this.persistMouthGate(kit.id, gateRecord);
      throw err;
    }
  }

  private async persistMouthGate(kitId: string, mouthGate: McKitMouthGate): Promise<void> {
    await this.dataSource
      .getRepository(McCharacterKit)
      .update({ id: kitId, status: McKitStatus.REVIEW }, { mouthGate });
  }

  /** Re-gera UMA célula do grid (plano §4). O kit permanece em review; o worker troca o asset do slot. */
  async regenerateReference(
    userId: string,
    id: string,
    dto: RegenerateReferenceDto,
  ): Promise<{ queued: boolean; slot: number }> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.REVIEW) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_IN_REVIEW',
        message: `O kit está em '${kit.status}' — referências só podem ser regeradas durante a revisão.`,
      });
    }
    if (!isKitReferenceSlot(dto.slot)) {
      throw new UnprocessableEntityException({
        code: 'INVALID_REFERENCE_SLOT',
        message: 'Slot inválido: use um valor entre 0 e 3.',
      });
    }
    // Regerar uma referência É gerar referência: sem estilo fixo, 422 (spec
    // "Estilo não escolhido"). Kits aprovados sem estilo não passam por aqui.
    if (!kit.style) throw this.styleRequired();
    await this.dataSource.transaction(async (manager) => {
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'reference_regeneration_requested',
        detail: { slot: dto.slot },
      });
      await this.queue.publish(
        QUEUES.MC_IMAGE,
        { kitId: kit.id, slot: dto.slot },
        {
          expireInSeconds: MC_IMAGE_EXPIRE_S,
          // evita dois jobs idênticos empilhados por duplo-clique do usuário
          singletonKey: `kit-regen:${kit.id}:${dto.slot}`,
        },
      );
    });
    return { queued: true, slot: dto.slot };
  }

  /**
   * Edita a ficha do personagem durante a revisão (v1.15). Existe porque a
   * ficha nasce da visão do modelo sobre a arte original e vem com os props
   * da imagem embutidos: o mascote da capivara vinha com "carrega uma cesta
   * de frutas" como TRAÇO e "nunca remover a cesta" como regra — o usuário
   * precisa poder dizer que aquilo é acessório, não personagem.
   *
   * Só em `review`: depois de aprovado o kit é imutável (plano §4/§6.3), senão
   * projetos antigos deixariam de ser reproduzíveis.
   */
  async updateSheet(userId: string, id: string, dto: UpdateKitSheetDto): Promise<McKitView> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.REVIEW) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_IN_REVIEW',
        message: `O kit está em '${kit.status}' — a ficha só pode ser ajustada durante a revisão.`,
      });
    }

    const current = parseCanonicalDesc(kit.canonicalDesc);
    const next: KitCanonicalDesc = {
      traits: dto.traits ? dto.traits.map((i) => i.en.trim()) : (current?.traits ?? []),
      colors: current?.colors ?? [],
      style: current?.style ?? '',
      doNots: dto.doNots ? dto.doNots.map((i) => i.en.trim()) : (current?.doNots ?? []),
      accessories: dto.accessories
        ? dto.accessories.map((i) => i.en.trim())
        : (current?.accessories ?? []),
    };
    const pt: KitCanonicalDescPt = {
      traits: dto.traits
        ? dto.traits.map((i) => (i.pt ?? i.en).trim())
        : (current?.pt?.traits ?? undefined),
      doNots: dto.doNots
        ? dto.doNots.map((i) => (i.pt ?? i.en).trim())
        : (current?.pt?.doNots ?? undefined),
      accessories: dto.accessories
        ? dto.accessories.map((i) => (i.pt ?? i.en).trim())
        : (current?.pt?.accessories ?? undefined),
      ...(current?.pt?.style ? { style: current.pt.style } : {}),
    };

    if (dto.adjustments !== undefined) {
      const text = dto.adjustments.trim();
      if (text) {
        pt.adjustments = text;
        next.adjustments = await this.candidates.translateAdjustments(text);
      }
    } else if (current?.adjustments) {
      next.adjustments = current.adjustments;
      if (current.pt?.adjustments) pt.adjustments = current.pt.adjustments;
    }

    const cleanPt = Object.fromEntries(Object.entries(pt).filter(([, v]) => v !== undefined));
    if (Object.keys(cleanPt).length > 0) next.pt = cleanPt as KitCanonicalDescPt;

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        McCharacterKit,
        { id: kit.id, status: McKitStatus.REVIEW },
        { canonicalDesc: JSON.stringify(next) },
      );
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'sheet_updated',
        detail: {
          traits: next.traits.length,
          accessories: next.accessories?.length ?? 0,
          doNots: next.doNots.length,
          hasAdjustments: !!next.adjustments,
        },
      });
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_kit', kitId: kit.id, status: kit.status },
        MC_EVENTS_CHANNEL,
      );
    });

    return this.findOne(userId, id);
  }

  /**
   * Traduz a ficha de um kit antigo (gerado antes do espelho pt-BR) sem
   * refazer imagem nenhuma — o usuário está olhando a ficha em inglês agora,
   * e regenerar o kit inteiro só por causa do idioma seria caro e bobo.
   * Idempotente: ficha já traduzida volta como está, sem gastar chamada.
   */
  async translateSheet(userId: string, id: string): Promise<McKitView> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.REVIEW) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_IN_REVIEW',
        message: `O kit está em '${kit.status}' — a ficha só pode ser ajustada durante a revisão.`,
      });
    }
    const desc = parseCanonicalDesc(kit.canonicalDesc);
    if (!desc) {
      throw new UnprocessableEntityException({
        code: 'KIT_SHEET_UNREADABLE',
        message: 'A ficha deste kit não está em formato legível para tradução.',
      });
    }
    if (hasPtMirror(desc)) return this.findOne(userId, id);

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'TRANSLATION_UNAVAILABLE',
        message: 'Tradução indisponível: o servidor está sem chave da OpenAI configurada.',
      });
    }
    const translated = mergeTranslatedSheet(desc, await this.requestSheetTranslation(desc, apiKey));

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        McCharacterKit,
        { id: kit.id, status: McKitStatus.REVIEW },
        { canonicalDesc: JSON.stringify(translated) },
      );
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'sheet_translated',
        detail: { traits: translated.pt?.traits?.length ?? 0 },
      });
    });
    return this.findOne(userId, id);
  }

  /** Chamada única de tradução da ficha (json_schema estrito, modelo rápido). */
  private async requestSheetTranslation(
    desc: KitCanonicalDesc,
    apiKey: string,
  ): Promise<KitSheetTranslation> {
    const openai = new OpenAI({ apiKey });
    const model = this.config.get<string>('OPENAI_FAST_TEXT_MODEL', 'gpt-4o-mini');
    const response = await openai.chat.completions.create({
      model,
      max_tokens: 900,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'kit_sheet_translation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['traits', 'accessories', 'doNots', 'style'],
            properties: {
              traits: { type: 'array', items: { type: 'string' } },
              accessories: { type: 'array', items: { type: 'string' } },
              doNots: { type: 'array', items: { type: 'string' } },
              style: { type: 'string' },
            },
          },
        },
      },
      messages: [
        {
          role: 'system',
          content:
            'Translate a cartoon mascot character sheet from English to Brazilian ' +
            'Portuguese. Keep the SAME number of items in each list, in the same order. ' +
            'Translate hex color codes as-is. Reply with JSON only.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            traits: desc.traits,
            accessories: desc.accessories ?? [],
            doNots: desc.doNots,
            style: desc.style,
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Resposta vazia do modelo de tradução');
    return JSON.parse(raw) as KitSheetTranslation;
  }

  async findAll(userId: string): Promise<McKitView[]> {
    const kits = await this.dataSource.getRepository(McCharacterKit).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return Promise.all(kits.map((kit) => this.view.toView(kit)));
  }

  async findOne(userId: string, id: string): Promise<McKitView> {
    return this.view.findOne(userId, id);
  }

  // ─────────────────────────────── internos ───────────────────────────────

  /** jsonb auditável da moderação (plano §6.8) — sem o raw gigante quando limpo. */
  private moderationJson(result: ModerationResult): Record<string, unknown> {
    return {
      provider: 'omni-moderation-latest',
      flagged: result.flagged,
      categories: result.categories,
      ...(result.skipped ? { skipped: true } : {}),
      at: new Date().toISOString(),
      ...(result.flagged && result.raw ? { raw: result.raw } : {}),
    };
  }
}
