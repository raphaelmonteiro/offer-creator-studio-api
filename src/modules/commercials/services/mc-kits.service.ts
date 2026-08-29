import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import OpenAI from 'openai';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ModerationProvider,
  ModerationResult,
} from '../../../shared/providers/moderation.provider';
import { sniffImageMime } from '../../../shared/providers/gemini-image.provider';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McVoicesService } from './mc-voices.service';
import {
  hasPtMirror,
  isKitReferenceSlot,
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

/** Geração do kit (4 imagens + descrição) leva minutos, não 15 — expiração própria da fila mc.image. */
export const MC_IMAGE_EXPIRE_S = 300;

/** Referência do kit resolvida para a UI de review (grid por slot, plano §4). */
export interface KitReferenceView {
  assetId: string;
  slot: number | null;
  url: string | null;
  createdAt: Date;
}

export type McKitView = McCharacterKit & { references: KitReferenceView[] };

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
  ) {}

  /**
   * Cria o kit: valida o mascote (existe, é do usuário, direitos confirmados,
   * tem imagem utilizável), modera a imagem e enfileira a geração. Kit nasce
   * 'generating'; o McKitProcessor o leva a 'review' (gate humano).
   */
  async createKit(userId: string, dto: CreateKitDto): Promise<McCharacterKit> {
    // MascotsService.findOne já resolve 404 (não existe) e 403 (de outro usuário).
    const mascot = await this.mascots.findOne(userId, dto.mascotId);

    if (!mascot.rightsConfirmedAt) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_RIGHTS_REQUIRED',
        message:
          'Confirme a titularidade ou licença de uso do mascote antes de criar o kit — ' +
          'abra o mascote na biblioteca e aceite o termo de direitos.',
      });
    }
    const imageUrl = mascot.cutoutUrl ?? mascot.sourceImageUrl;
    if (!imageUrl) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_IMAGE_REQUIRED',
        message:
          'Este mascote não tem imagem utilizável. Envie o PNG do mascote ' +
          '(de preferência com fundo transparente) e tente de novo.',
      });
    }
    const imageBuffer = await this.readUploadsFile(imageUrl);
    if (!imageBuffer) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_IMAGE_MISSING',
        message:
          'A imagem do mascote não foi encontrada no servidor. ' +
          'Envie o arquivo novamente na biblioteca de mascotes.',
      });
    }

    // Moderação ANTES de gastar com providers (plano §6.8). Indisponibilidade
    // do moderador BLOQUEIA a criação (fail-closed com erro acionável) — a
    // exceção é a ausência de OPENAI_API_KEY em dev, que vira `skipped`
    // auditado no jsonb.
    let moderation: ModerationResult;
    try {
      moderation = await this.moderation.moderate({
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

    if (moderation.flagged) {
      // Resultado auditado MESMO no bloqueio: o kit nasce 'failed' com o
      // jsonb da moderação — trilha do §6.8 sem gastar um centavo de geração.
      const blocked = await this.dataSource.getRepository(McCharacterKit).save({
        userId,
        mascotId: dto.mascotId,
        status: McKitStatus.FAILED,
        voiceId: dto.voiceId ?? null,
        moderation: this.moderationJson(moderation),
      });
      await this.dataSource.transaction(async (manager) => {
        await this.commercials.appendEvent(manager, {
          userId,
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

    // Criação + enqueue na MESMA transação (pg-boss é Postgres): se o publish
    // falhar, o kit não fica órfão em 'generating' para sempre.
    return this.dataSource.transaction(async (manager) => {
      const kit = await manager.getRepository(McCharacterKit).save({
        userId,
        mascotId: dto.mascotId,
        status: McKitStatus.GENERATING,
        voiceId: dto.voiceId ?? null,
        moderation: this.moderationJson(moderation),
      });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: null,
        toStatus: McKitStatus.GENERATING,
        detail: { mascotId: dto.mascotId },
      });
      await this.queue.publish(
        QUEUES.MC_IMAGE,
        { kitId: kit.id },
        { expireInSeconds: MC_IMAGE_EXPIRE_S },
      );
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.GENERATING },
        MC_EVENTS_CHANNEL,
      );
      return kit;
    });
  }

  /** review → approved (gate humano §4). Exige voz definida — aqui ou na criação. */
  async approveKit(userId: string, id: string, dto: ApproveKitDto): Promise<McCharacterKit> {
    const kit = await this.getOwned(userId, id);
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
    // preview: a UI envia o id da linha do catálogo).
    const voiceId = await this.voices.resolveProviderVoiceId(voiceInput);

    assertKitTransition(McKitStatus.REVIEW, McKitStatus.APPROVED);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.REVIEW,
        McKitStatus.APPROVED,
        { approvedAt: new Date(), voiceId },
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
        detail: { voiceId },
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

  /** Re-gera UMA célula do grid (plano §4). O kit permanece em review; o worker troca o asset do slot. */
  async regenerateReference(
    userId: string,
    id: string,
    dto: RegenerateReferenceDto,
  ): Promise<{ queued: boolean; slot: number }> {
    const kit = await this.getOwned(userId, id);
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
    const kit = await this.getOwned(userId, id);
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
        next.adjustments = await this.translateAdjustments(text);
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
    const kit = await this.getOwned(userId, id);
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

  /**
   * Ajuste do usuário chega em pt-BR e os motores de imagem leem inglês.
   * Tradução best-effort: sem chave (ou em modo mock, ou se a API falhar) o
   * texto original segue como está — pior prompt, nunca erro na tela.
   */
  private async translateAdjustments(textPt: string): Promise<string> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey || (process.env.MC_KIT_PROVIDER ?? 'mock') === 'mock') return textPt;
    try {
      const openai = new OpenAI({ apiKey });
      const model = this.config.get<string>('OPENAI_FAST_TEXT_MODEL', 'gpt-4o-mini');
      const response = await openai.chat.completions.create({
        model,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              'Translate the user instruction about a cartoon mascot from Brazilian ' +
              'Portuguese to English. It will be appended to an image generation prompt. ' +
              'Reply with the translation only, imperative and literal, no quotes.',
          },
          { role: 'user', content: textPt },
        ],
      });
      const out = response.choices[0]?.message?.content?.trim();
      return out && out.length > 0 ? out.slice(0, 600) : textPt;
    } catch (err) {
      this.logger.warn(`Tradução do ajuste da ficha falhou, mantendo pt-BR: ${String(err)}`);
      return textPt;
    }
  }

  async findAll(userId: string): Promise<McKitView[]> {
    const kits = await this.dataSource.getRepository(McCharacterKit).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return Promise.all(kits.map((kit) => this.toView(kit)));
  }

  async findOne(userId: string, id: string): Promise<McKitView> {
    return this.toView(await this.getOwned(userId, id));
  }

  // ─────────────────────────────── internos ───────────────────────────────

  private async getOwned(userId: string, id: string): Promise<McCharacterKit> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id });
    if (!kit) throw new NotFoundException('Kit não encontrado');
    if (kit.userId !== userId) throw new ForbiddenException();
    return kit;
  }

  /** Resolve referenceAssetIds em URLs para a UI (slot vem do metadata do asset). */
  private async toView(kit: McCharacterKit): Promise<McKitView> {
    if (kit.referenceAssetIds.length === 0) return { ...kit, references: [] };
    const assets = await this.dataSource.getRepository(AnimationAsset).find({
      where: { id: In(kit.referenceAssetIds) },
    });
    const references = assets
      .map((asset) => ({
        assetId: asset.id,
        slot: typeof asset.metadata?.slot === 'number' ? (asset.metadata.slot as number) : null,
        url: asset.fileUrl,
        createdAt: asset.createdAt,
      }))
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
    return { ...kit, references };
  }

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

  /** Lê um arquivo do bucket local a partir da URL persistida (mesma lógica do MascotsService). */
  private async readUploadsFile(url: string): Promise<Buffer | null> {
    const marker = '/uploads/';
    const index = url.indexOf(marker);
    const uploadsPath = url.startsWith('/uploads/') ? url : index >= 0 ? url.slice(index) : null;
    if (!uploadsPath) return null;
    const uploadsDir = path.resolve(this.config.get<string>('UPLOAD_DEST', './uploads'));
    const filePath = path.resolve(uploadsDir, uploadsPath.replace(/^\/uploads\//, ''));
    if (!filePath.startsWith(uploadsDir + path.sep)) return null;
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }
}
