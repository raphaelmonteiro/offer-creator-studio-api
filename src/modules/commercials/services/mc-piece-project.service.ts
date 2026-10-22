import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { buildOfferLineText, plannedTalkDurationS, samePrice } from '../domain/mc-director';
import {
  MC_PIECE_MAX_BYTES,
  McPieceChangeScope,
  McPieceDocument,
  McProjectPieceExtras,
  pieceBlock,
  pieceCanonicalHash,
  pieceChangeScope,
  pieceCharacterVideoFields,
  pieceDocumentBytes,
  pieceSpokenOffers,
} from '../domain/mc-piece';
import { isPipelineV2, resolveQuality } from '../domain/mc-quality';
import { carouselOffers, deriveCarouselLines, isScriptV2 } from '../domain/mc-script-v2';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McScript, McSealProduct, resolveProjectOptions } from '../domain/mc-types';
import { UpdateProjectPieceDto } from '../dto/piece.dto';
import { ScriptProductV2Dto, ScriptSceneV2Dto, UpdateScriptV2Dto } from '../dto/quality-v2.dto';
import { McProject } from '../entities/mc-project.entity';
import { McFromPieceService } from './mc-from-piece.service';
import { McPiecesService } from './mc-pieces.service';
import { McQualityService } from './mc-quality.service';

/** Fala reescrita por uma edição falada da peça (confirmada na revisão do roteiro). */
export interface McPieceLineRewrite {
  offerId: string;
  /** null = oferta nova (cena nova). */
  sceneId: string | null;
  previousDialogue: string | null;
  proposedDialogue: string;
}

export interface McPieceChange {
  scope: Exclude<McPieceChangeScope, 'none'>;
  /**
   * `recording`: volta à revisão do roteiro e regrava o que mudou (fala, cor do
   * painel ou modo do personagem); `composition`: só quadro + compose + finalize.
   */
  effect: 'recording' | 'composition';
  rewrittenLines: McPieceLineRewrite[];
}

/**
 * `PATCH projects/:id/piece` (change video-peca-configuravel, tarefa 5.4; spec
 * "Preço alterado depois do vídeo" e regra do PATCH /composition do F2 aplicada
 * ao descritor): a peça editada depois do vídeo existir.
 *
 * - `pieceChangeScope` decide: mudança FALADA (item falado com nome/preço/
 *   unidade novos, falado entrando/saindo, ordem dos falados) reescreve a frase
 *   de cada oferta afetada pelo line builder do F2 (as demais falas ficam) e
 *   segue `updateScript` — revisão do roteiro, só o TTS/talk dessas falas mudam
 *   de hash; mudança só VISUAL depois da entrega abre a revisão `assembly_only`
 *   (render_still + compose + finalize) por `updateComposition`; antes da
 *   entrega é gravada no lugar (`updatePieceInPlace`).
 * - Cor do painel ou modo do personagem também regravam (a cor está nos clipes
 *   de fala — mesma regra do F1): seguem o caminho falado mesmo sem fala nova.
 * - Formato (aspecto) e kit não mudam aqui: 422 — duplique o vídeo.
 * - `pieceSnapshot`, `logoBox` (rosto do logo) e `options.products` acompanham
 *   o descritor na mesma transação.
 */
@Injectable()
export class McPieceProjectService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pieces: McPiecesService,
    private readonly quality: McQualityService,
  ) {}

  async updatePiece(
    userId: string,
    projectId: string,
    dto: UpdateProjectPieceDto,
  ): Promise<McProject & { pieceChange: McPieceChange }> {
    const project = await this.pieceProject(userId, projectId);
    if (project.revision !== dto.expectedRevision) {
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: `O projeto está na revisão ${project.revision}, não ${dto.expectedRevision}. Recarregue para continuar.`,
        revision: project.revision,
      });
    }
    const before = project.pieceSnapshot as McPieceDocument;
    const after = dto.document;
    if (after.aspectRatio !== project.aspectRatio) {
      throw new UnprocessableEntityException({
        code: 'PIECE_ASPECT_MISMATCH',
        message:
          'O formato da peça não muda num vídeo existente — duplique o vídeo no outro formato.',
        details: { projectAspectRatio: project.aspectRatio, pieceAspectRatio: after.aspectRatio },
      });
    }
    if (pieceDocumentBytes(after) > MC_PIECE_MAX_BYTES) {
      throw new UnprocessableEntityException({
        code: 'PIECE_TOO_LARGE',
        message: 'A peça passou do tamanho máximo (2 MiB).',
      });
    }
    const issues = await this.pieces.issuesFor(userId, after);
    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        code: 'PIECE_INVALID',
        message: 'A peça editada ainda não está pronta para o vídeo.',
        issues,
      });
    }
    const character = pieceBlock(after, 'character');
    const video = pieceCharacterVideoFields(after);
    if (!character || !video) {
      throw new UnprocessableEntityException({
        code: 'PIECE_INVALID',
        message: 'A peça precisa de um personagem.',
        issues: [{ code: 'CHARACTER_MISSING', message: 'A peça precisa de um personagem.' }],
      });
    }
    if (character.kitId !== project.kitId) {
      throw new UnprocessableEntityException({
        code: 'PIECE_KIT_CHANGED',
        message: 'O personagem do vídeo não muda numa edição — crie outro vídeo com o novo kit.',
        details: { projectKitId: project.kitId, pieceKitId: character.kitId },
      });
    }
    const scope = pieceChangeScope(before, after);
    if (scope === 'none') {
      throw new UnprocessableEntityException({
        code: 'NO_PIECE_CHANGE',
        message: 'Nada mudou na peça.',
      });
    }
    const previousCharacter = pieceBlock(before, 'character');
    const panelChanged =
      (previousCharacter?.panel?.color ?? '').trim().toUpperCase() !==
      (character.panel?.color ?? '').trim().toUpperCase();
    const modeChanged = (previousCharacter?.mode ?? null) !== character.mode;
    const recording = scope === 'spoken' || panelChanged || modeChanged;

    const script = project.script as McScript;
    const extras: McProjectPieceExtras = {
      pieceSnapshot: after,
      logoBox: McFromPieceService.logoBoxFor(after),
      options: {
        ...resolveProjectOptions(project.options),
        products: pieceSpokenOffers(after).map((o) => ({ ...o })),
      },
    };
    const quality = resolveQuality(project.quality);
    const delivered =
      project.status === McProjectStatus.SUCCEEDED ||
      (project.status === McProjectStatus.VISUAL_REVIEW &&
        quality.pendingScope === 'assembly_only');

    let updated: McProject;
    let rewrittenLines: McPieceLineRewrite[] = [];
    if (recording) {
      const built = this.scriptDto(script, after, dto.expectedRevision, video);
      rewrittenLines = built.rewritten;
      updated = await this.quality.updateScript(userId, projectId, built.dto, extras);
    } else if (delivered) {
      updated = await this.quality.updateComposition(
        userId,
        projectId,
        { expectedRevision: dto.expectedRevision, window: { ...video.window } },
        extras,
      );
    } else {
      updated = await this.quality.updatePieceInPlace(userId, projectId, {
        expectedRevision: dto.expectedRevision,
        extras,
        video,
      });
    }
    return {
      ...updated,
      pieceChange: {
        scope,
        effect: recording ? 'recording' : 'composition',
        rewrittenLines,
      },
    };
  }

  // ─────────────────────────────── internos ───────────────────────────────

  private async pieceProject(userId: string, projectId: string): Promise<McProject> {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado' });
    }
    if (project.userId !== userId) throw new ForbiddenException();
    if (
      project.format !== 'offer_piece' ||
      !isPipelineV2(project) ||
      !project.script ||
      !isScriptV2(project.script) ||
      !project.pieceSnapshot
    ) {
      throw new UnprocessableEntityException({
        code: 'FORMAT_NOT_OFFER_PIECE',
        message:
          'Esta ação só existe em vídeos feitos a partir de uma peça de ofertas com roteiro.',
        details: { format: project.format },
      });
    }
    return project;
  }

  /**
   * O roteiro atual como DTO do PATCH script com as ofertas FALADAS da peça
   * nova, na ordem dela: abertura e fechamento ficam; a fala de uma oferta
   * cuja impressão falada (nome, preço, unidade) não mudou é preservada com a
   * mesma identidade de cena (TTS e clipe vêm do cache); as demais são
   * reescritas pelo line builder; ofertas novas ganham cena nova e as que
   * saíram levam a cena embora. Janela, rosto do logo e cor do painel vêm da
   * peça editada.
   */
  private scriptDto(
    script: McScript,
    after: McPieceDocument,
    expectedRevision: number,
    video: NonNullable<ReturnType<typeof pieceCharacterVideoFields>>,
  ): { dto: UpdateScriptV2Dto; rewritten: McPieceLineRewrite[] } {
    const offers = pieceSpokenOffers(after);
    const previousOffers = new Map(carouselOffers(script).map((o) => [o.id as string, o]));
    const lines = script.lines ?? deriveCarouselLines(script.scenes);
    const sceneById = new Map(script.scenes.map((s) => [s.sceneId as string, s]));
    const lineFor = (kind: 'opening' | 'closing') => lines.find((l) => l.kind === kind);
    const offerScene = (offerId: string) => {
      const line = lines.find((l) => l.kind === 'offer' && l.offerRef === offerId);
      return line ? (sceneById.get(line.sceneId) ?? null) : null;
    };
    const toSceneDto = (scene: McScript['scenes'][number]): ScriptSceneV2Dto => ({
      sceneId: scene.sceneId,
      sceneType: 'talk_tile',
      initialFrame: scene.initialFrame,
      actionPrompt: scene.actionPrompt ?? '',
      dialogue: scene.dialogue,
      durationS: scene.durationS,
      productRef: scene.productRef ?? null,
      sealCue: scene.sealCue ?? null,
      safeArea: scene.safeArea ?? null,
      camera: scene.camera ?? null,
      environmentId: scene.environmentId ?? null,
    });
    const rewritten: McPieceLineRewrite[] = [];
    const scenes: ScriptSceneV2Dto[] = [];
    const opening = lineFor('opening');
    if (opening && sceneById.has(opening.sceneId)) {
      scenes.push(toSceneDto(sceneById.get(opening.sceneId) as McScript['scenes'][number]));
    }
    for (const offer of offers) {
      const previous = previousOffers.get(offer.id as string);
      const scene = offerScene(offer.id as string);
      const unchanged =
        !!previous &&
        !!scene &&
        previous.name.trim() === offer.name.trim() &&
        samePrice(previous.price, offer.price) &&
        (previous.unit ?? null) === (offer.unit ?? null) &&
        !!scene.dialogue;
      if (unchanged) {
        scenes.push({ ...toSceneDto(scene), productRef: offer.id as string });
        continue;
      }
      const dialogue = buildOfferLineText(offer);
      rewritten.push({
        offerId: offer.id as string,
        sceneId: scene?.sceneId ?? null,
        previousDialogue: scene?.dialogue ?? null,
        proposedDialogue: dialogue,
      });
      scenes.push({
        ...(scene ? { sceneId: scene.sceneId } : {}),
        sceneType: 'talk_tile',
        actionPrompt: scene?.actionPrompt ?? '',
        dialogue,
        durationS: plannedTalkDurationS(dialogue),
        productRef: offer.id as string,
        sealCue: null,
        safeArea: null,
        camera: null,
        environmentId: null,
      });
    }
    const closing = lineFor('closing');
    if (closing && sceneById.has(closing.sceneId)) {
      scenes.push(toSceneDto(sceneById.get(closing.sceneId) as McScript['scenes'][number]));
    }
    const products: ScriptProductV2Dto[] = offers.map((o: McSealProduct) => ({
      id: o.id,
      catalogId: o.catalogId ?? null,
      unit: o.unit ?? null,
      name: o.name,
      price: o.price,
      imageUrl: o.imageUrl ?? null,
      originalPrice: o.originalPrice ?? null,
      badge: o.badge ?? null,
    }));
    return {
      dto: {
        expectedRevision,
        scenes,
        offers: products,
        products,
        window: { ...video.window },
        logoFace: video.logoFace,
        talkBackgroundColor: video.talkBackgroundColor,
      },
      rewritten,
    };
  }
}

/** Hash do descritor para o evento/resposta (reexport conveniente aos consumidores). */
export const pieceHashOf = pieceCanonicalHash;
