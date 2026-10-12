import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { sniffImageMime } from '../../../shared/providers/gemini-image.provider';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import {
  buildKitCandidatePrompt,
  buildMouthVariantPrompt,
  KIT_CANDIDATES_DEFAULT,
  KIT_CANDIDATES_MAX,
  KIT_CANDIDATES_MIN,
} from '../domain/kit-prompts';
import { McKitStyle } from '../domain/mc-kit-identity';
import { decideMouthGate, McKitMouthGate } from '../domain/mc-mouth-gate';
import { assertKitTransition, McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitCandidate, McKitCandidateKind } from '../entities/mc-kit-candidate.entity';
import { McKitTileService } from './mc-kit-tile.service';
import { McKitView, McKitViewService } from './mc-kit-view.service';
import { McStorageService } from './mc-storage.service';

/** Geração do kit (4 imagens + descrição) leva minutos, não 15 — expiração própria da fila mc.image. */
export const MC_IMAGE_EXPIRE_S = 300;
/** Uma rodada = 4 a 6 chamadas de imagem em sequência: expiração própria, acima da do kit. */
export const MC_CANDIDATES_EXPIRE_S = 600;

/** Payload do job de rodada na fila mc.image (despachado pelo módulo por `candidates: true`). */
export interface McKitCandidatesJob {
  kitId: string;
  candidates: true;
  roundId: string;
}

export interface KitCandidateView {
  id: string;
  idx: number;
  assetId: string | null;
  url: string | null;
  chosen: boolean;
  prompt: string;
  createdAt: Date;
}

export interface KitCandidateRoundView {
  roundId: string;
  kind: McKitCandidateKind;
  adjustments: string | null;
  createdAt: Date;
  candidates: KitCandidateView[];
}

export interface KitCandidatesView {
  kitId: string;
  status: McKitStatus;
  currentRoundId: string | null;
  useAsIsAvailable: boolean;
  rounds: KitCandidateRoundView[];
}

/** Referências de estilo opcionais: `{MC_KIT_STYLE_REFS_DIR}/{style}-{1..3}.(png|jpg|webp)`. */
export async function listStyleReferences(
  style: McKitStyle | null,
  dir: string | undefined = process.env.MC_KIT_STYLE_REFS_DIR,
): Promise<string[]> {
  if (!style || !dir) return [];
  const files: string[] = [];
  for (const n of [1, 2, 3]) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const file = path.join(dir, `${style}-${n}.${ext}`);
      try {
        await fs.access(file);
        files.push(file);
        break;
      } catch {
        // próxima extensão
      }
    }
  }
  return files;
}

/** Candidatos por rodada (MC_KIT_CANDIDATE_COUNT), sempre dentro de 4..6. */
export function candidateCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MC_KIT_CANDIDATE_COUNT);
  if (!Number.isInteger(raw)) return KIT_CANDIDATES_DEFAULT;
  return Math.min(KIT_CANDIDATES_MAX, Math.max(KIT_CANDIDATES_MIN, raw));
}

/**
 * Rodadas de candidatos de mascotização e variante com boca (D4): abre a
 * rodada (linhas pré-inseridas + job na mc.image), nova rodada com ajustes,
 * escolha do candidato (vira `identityAssetId`, referências refeitas a
 * partir dele) e "usar o logo como está" (`logo_as_is`, sem referências).
 * Rodadas anteriores são preservadas para comparação.
 */
@Injectable()
export class McKitCandidatesService {
  private readonly logger = new Logger(McKitCandidatesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly queue: AnimationQueueService,
    private readonly commercials: CommercialsService,
    private readonly storage: McStorageService,
    private readonly mascots: MascotsService,
    private readonly config: ConfigService,
    private readonly view: McKitViewService,
    private readonly tile: McKitTileService,
  ) {}

  /**
   * Abre uma rodada DENTRO da transação de quem chama (criação do kit ou
   * nova rodada): candidatos pré-inseridos com `assetId` nulo (a UI vê a
   * rodada em andamento e os ajustes sobrevivem a um job perdido), kit com
   * `candidateRoundId` apontando para ela, e o job na mc.image. O processor
   * preenche os assets e leva o kit a `candidates`.
   */
  async openRound(
    manager: EntityManager,
    kit: Pick<
      McCharacterKit,
      'id' | 'userId' | 'style' | 'source' | 'tileBackgroundColor' | 'identityMode'
    >,
    options: {
      kind: McKitCandidateKind;
      adjustments?: string | null;
      adjustmentsEn?: string | null;
    },
  ): Promise<{ roundId: string; count: number }> {
    const roundId = randomUUID();
    const count = options.kind === 'mouth_variant' ? 1 : candidateCount();
    const styleRefs = options.kind === 'mascotization' ? await listStyleReferences(kit.style) : [];
    const rows = Array.from({ length: count }, (_, idx) => ({
      kitId: kit.id,
      roundId,
      idx,
      kind: options.kind,
      assetId: null,
      adjustments: options.adjustments?.trim() || null,
      chosen: false,
      prompt:
        options.kind === 'mascotization'
          ? buildKitCandidatePrompt({
              style: kit.style as McKitStyle,
              backgroundColor: kit.tileBackgroundColor,
              adjustments: options.adjustmentsEn ?? options.adjustments ?? null,
              idx,
              total: count,
              styleReferenceCount: styleRefs.length,
            })
          : buildMouthVariantPrompt({
              style: kit.style,
              source: kit.source,
              backgroundColor: kit.tileBackgroundColor,
            }),
    }));
    await manager.insert(McKitCandidate, rows);
    await manager.update(McCharacterKit, { id: kit.id }, { candidateRoundId: roundId });
    await this.commercials.appendEvent(manager, {
      userId: kit.userId,
      refKind: 'kit',
      refId: kit.id,
      kind: 'candidates_round_opened',
      detail: {
        roundId,
        kind: options.kind,
        count,
        adjustments: options.adjustments ?? null,
        styleReferences: styleRefs.length,
      },
    });
    await this.queue.publish(
      QUEUES.MC_IMAGE,
      { kitId: kit.id, candidates: true, roundId },
      {
        expireInSeconds: MC_CANDIDATES_EXPIRE_S,
        singletonKey: `kit-candidates:${kit.id}:${roundId}`,
      },
    );
    return { roundId, count };
  }

  /** POST /kits/:id/candidates — nova rodada com ajustes; só com a rodada anterior pronta. */
  async startRound(userId: string, id: string, adjustments?: string): Promise<McKitView> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.CANDIDATES) throw this.notInCandidates(kit);
    if (!kit.style) throw this.styleRequired();
    const text = adjustments?.trim() || null;
    const adjustmentsEn = text ? await this.translateAdjustments(text) : null;

    assertKitTransition(McKitStatus.CANDIDATES, McKitStatus.GENERATING);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.CANDIDATES,
        McKitStatus.GENERATING,
      );
      if (!won) throw this.notInCandidates(kit, true);
      const round = await this.openRound(manager, kit, {
        kind: 'mascotization',
        adjustments: text,
        adjustmentsEn,
      });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.CANDIDATES,
        toStatus: McKitStatus.GENERATING,
        detail: { roundId: round.roundId, adjustments: text },
      });
      await this.notify(manager, kit, McKitStatus.GENERATING);
    });
    return this.view.findOne(userId, id);
  }

  /**
   * POST /kits/:id/candidates/:cid/choose — o candidato vira a identidade
   * (`identityMode = generated`), o tile anterior é descartado e as
   * referências são geradas a partir dele (como num kit de mascote). Vale em
   * `candidates` (primeira escolha) e em `review` (troca de identidade /
   * variante com boca escolhida).
   */
  async choose(userId: string, id: string, candidateId: string): Promise<McKitView> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.CANDIDATES && kit.status !== McKitStatus.REVIEW) {
      throw this.notInCandidates(kit);
    }
    const candidate = await this.dataSource
      .getRepository(McKitCandidate)
      .findOneBy({ id: candidateId, kitId: kit.id });
    if (!candidate) throw new NotFoundException('Candidato não encontrado neste kit');
    if (!candidate.assetId) {
      throw new UnprocessableEntityException({
        code: 'CANDIDATE_NOT_READY',
        message: 'Este candidato ainda não foi gerado. Aguarde a rodada terminar.',
      });
    }
    if (!kit.style) throw this.styleRequired();

    const from = kit.status;
    assertKitTransition(from, McKitStatus.GENERATING);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        from,
        McKitStatus.GENERATING,
        {
          identityAssetId: candidate.assetId,
          identityMode: 'generated',
          tileAssetId: null,
          mouthGate: this.withoutIdentityVerdict(kit.mouthGate),
        },
      );
      if (!won) throw this.notInCandidates(kit, true);
      await manager.update(McKitCandidate, { kitId: kit.id, chosen: true }, { chosen: false });
      await manager.update(McKitCandidate, { id: candidate.id }, { chosen: true });
      await this.tile.discard(manager, kit.tileAssetId);
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: from,
        toStatus: McKitStatus.GENERATING,
        detail: {
          candidateId: candidate.id,
          roundId: candidate.roundId,
          candidateKind: candidate.kind,
          identityAssetId: candidate.assetId,
          previousIdentityAssetId: kit.identityAssetId ?? null,
          tileDiscarded: kit.tileAssetId ?? null,
        },
      });
      await this.queue.publish(
        QUEUES.MC_IMAGE,
        { kitId: kit.id },
        { expireInSeconds: MC_IMAGE_EXPIRE_S, singletonKey: `kit-refs:${kit.id}:${candidate.id}` },
      );
      await this.notify(manager, kit, McKitStatus.GENERATING);
    });
    return this.view.findOne(userId, id);
  }

  /**
   * POST /kits/:id/use-as-is — só quando o gate de boca passou no logo cru:
   * os pixels originais do logo viram a identidade (`logo_as_is`), sem
   * mascotização nem referências; o kit vai direto à revisão (voz + tile).
   */
  async useAsIs(userId: string, id: string): Promise<McKitView> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.source !== 'logo') {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_LOGO',
        message: '"Usar como está" só vale para kits criados a partir de um logo.',
      });
    }
    if (kit.status !== McKitStatus.CANDIDATES) throw this.notInCandidates(kit);
    if (decideMouthGate(kit.mouthGate?.logo) !== 'passed') {
      throw new UnprocessableEntityException({
        code: 'LOGO_MOUTH_NOT_LEGIBLE',
        message:
          'O logo não tem boca legível para falar como está. Escolha um candidato de ' +
          'mascotização (ou peça uma nova rodada).',
      });
    }
    const asset = await this.copyLogoAsIdentity(userId, kit);

    assertKitTransition(McKitStatus.CANDIDATES, McKitStatus.REVIEW);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.CANDIDATES,
        McKitStatus.REVIEW,
        {
          identityMode: 'logo_as_is',
          identityAssetId: asset.id,
          candidateRoundId: null,
          tileAssetId: null,
          mouthGate: this.withoutIdentityVerdict(kit.mouthGate),
        },
      );
      if (!won) throw this.notInCandidates(kit, true);
      await this.tile.discard(manager, kit.tileAssetId);
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.CANDIDATES,
        toStatus: McKitStatus.REVIEW,
        detail: { identityMode: 'logo_as_is', identityAssetId: asset.id },
      });
      await this.notify(manager, kit, McKitStatus.REVIEW);
    });
    return this.view.findOne(userId, id);
  }

  /**
   * POST /kits/:id/mouth-variant — gate de boca reprovado/indeciso na
   * revisão: gera uma variante da identidade atual com boca articulável
   * (rodada `mouth_variant`, 1 candidato). O kit fica em revisão; o usuário
   * escolhe a variante com `choose` e as referências são refeitas.
   */
  async requestMouthVariant(userId: string, id: string): Promise<McKitView> {
    const kit = await this.view.findOwned(userId, id);
    if (kit.status !== McKitStatus.REVIEW) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_IN_REVIEW',
        message: `O kit está em '${kit.status}' — a variante com boca só pode ser gerada na revisão.`,
      });
    }
    const identity = await this.view.resolveIdentityAsset(kit);
    if (!identity) {
      throw new UnprocessableEntityException({
        code: 'KIT_IDENTITY_MISSING',
        message:
          'O kit não tem identidade para variar: regenere a referência frontal (slot 2) ' +
          'ou escolha um candidato.',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      const round = await this.openRound(manager, kit, { kind: 'mouth_variant' });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'mouth_variant_requested',
        detail: { roundId: round.roundId, identityAssetId: identity.id },
      });
      await this.notify(manager, kit, McKitStatus.REVIEW, 'mouth_variant_requested');
    });
    return this.view.findOne(userId, id);
  }

  /** GET /kits/:id/candidates — rodadas (antigas preservadas) com URLs dos assets. */
  async list(userId: string, id: string): Promise<KitCandidatesView> {
    const kit = await this.view.findOwned(userId, id);
    const rows = await this.dataSource.getRepository(McKitCandidate).find({
      where: { kitId: kit.id },
      order: { createdAt: 'ASC', idx: 'ASC' },
    });
    const assetIds = rows.map((r) => r.assetId).filter((v): v is string => !!v);
    const assets =
      assetIds.length > 0
        ? await this.dataSource.getRepository(AnimationAsset).find({ where: { id: In(assetIds) } })
        : [];
    const urlById = new Map(assets.map((a) => [a.id, a.fileUrl]));
    const rounds = new Map<string, KitCandidateRoundView>();
    for (const row of rows) {
      let round = rounds.get(row.roundId);
      if (!round) {
        round = {
          roundId: row.roundId,
          kind: row.kind ?? 'mascotization',
          adjustments: row.adjustments,
          createdAt: row.createdAt,
          candidates: [],
        };
        rounds.set(row.roundId, round);
      }
      round.candidates.push({
        id: row.id,
        idx: row.idx,
        assetId: row.assetId,
        url: row.assetId ? (urlById.get(row.assetId) ?? null) : null,
        chosen: row.chosen,
        prompt: row.prompt,
        createdAt: row.createdAt,
      });
    }
    const view = await this.view.toView(kit);
    return {
      kitId: kit.id,
      status: kit.status,
      currentRoundId: kit.candidateRoundId,
      useAsIsAvailable: view.useAsIsAvailable,
      rounds: [...rounds.values()],
    };
  }

  /**
   * Ajuste do usuário chega em pt-BR e os motores de imagem leem inglês.
   * Tradução best-effort: sem chave (ou em modo mock, ou se a API falhar) o
   * texto original segue como está — pior prompt, nunca erro na tela.
   */
  async translateAdjustments(textPt: string): Promise<string> {
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
      this.logger.warn(`Tradução do ajuste falhou, mantendo pt-BR: ${String(err)}`);
      return textPt;
    }
  }

  // ─────────────────────────────── internos ───────────────────────────────

  /** Pixels ORIGINAIS do logo (recorte com alfa, senão a fonte) copiados para a área do kit. */
  private async copyLogoAsIdentity(userId: string, kit: McCharacterKit): Promise<AnimationAsset> {
    const mascot = await this.mascots.findOne(userId, kit.mascotId);
    const imageUrl = mascot.cutoutUrl ?? mascot.sourceImageUrl;
    const buffer = imageUrl ? await this.storage.readUploadsFile(imageUrl) : null;
    if (!buffer) {
      throw new UnprocessableEntityException({
        code: 'MASCOT_IMAGE_MISSING',
        message: 'A imagem do logo não foi encontrada no servidor. Envie o arquivo novamente.',
      });
    }
    const mime = sniffImageMime(buffer);
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const url = await this.storage.saveFile(
      `commercials/kits/${kit.id}`,
      `identity-logo-${Date.now()}.${ext}`,
      buffer,
    );
    return this.dataSource.getRepository(AnimationAsset).save({
      userId,
      kind: 'kit_candidate' as const,
      status: 'ready' as const,
      name: `Logo como está — ${kit.id.slice(0, 8)}`,
      origin: 'imported' as const,
      fileUrl: url,
      mimeType: mime,
      width: mascot.width ?? null,
      height: mascot.height ?? null,
      hasAlpha: Boolean(mascot.hasAlpha),
      fileSize: String(buffer.length),
      metadata: {
        kitId: kit.id,
        role: 'logo_as_is',
        sourceMascotId: mascot.id,
        sourceUrl: imageUrl,
      },
    });
  }

  /** Identidade trocada: o veredito sobre a identidade anterior e o aceite de risco caem. */
  private withoutIdentityVerdict(gate: McKitMouthGate | null): McKitMouthGate | null {
    if (!gate) return null;
    const { identity: _identity, riskAccepted: _risk, ...rest } = gate;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  private async notify(
    manager: EntityManager,
    kit: McCharacterKit,
    status: McKitStatus,
    event?: string,
  ): Promise<void> {
    await this.transitions.notify(
      manager,
      kit.userId,
      { kind: 'mc_kit', kitId: kit.id, status, ...(event ? { event } : {}) },
      MC_EVENTS_CHANNEL,
    );
  }

  private notInCandidates(kit: McCharacterKit, raced = false): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'KIT_NOT_IN_CANDIDATES',
      message: raced
        ? 'O kit mudou de estado durante a operação. Recarregue e tente de novo.'
        : `O kit está em '${kit.status}' — esta ação só vale com a rodada de candidatos pronta.`,
    });
  }

  private styleRequired(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'STYLE_REQUIRED',
      message:
        'Escolha o estilo do personagem (cartoon_2d, 3d_render ou realistic) antes de gerar ' +
        'candidatos ou referências do kit.',
    });
  }
}
