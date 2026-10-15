import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { CreditsService, creditsEnabled } from '../../../shared/credits/credits.service';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ModerationProvider,
  ModerationResult,
} from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService, MC_PAUSED_KEY } from '../commercials.service';
import { scenePlan, sceneUsesKeyframe } from '../domain/mc-execution-plan';
import {
  klingActionDuration,
  mcTalkEngines,
  talkEngineFor,
  talkFallbackEngineKey,
} from '../domain/mc-pipeline.config';
import {
  custoProducaoDaCena,
  MC_STEP_CREDITS,
  projectAssemblyQuoteItems,
  quotePhase,
} from '../domain/mc-pricing.config';
import {
  approvalAuthorizes,
  findPhaseBudget,
  isPipelineV2,
  McApprovalManifest,
  McPhase,
  McPhaseBudget,
  McPhaseQuote,
  McQualityState,
  McQuoteItem,
  MC_PIPELINE_V2,
  MC_SCRIPT_SCHEMA_V2,
  phaseLedgerKey,
  resolveQuality,
  upsertPhaseBudget,
} from '../domain/mc-quality';
import { assertLogoFaceReady } from '../domain/mc-logo-face';
import { voiceoverPlanExcessMs } from '../domain/mc-scene-compose-graph';
import { preparationComplete } from '../domain/mc-scheduler';
import {
  carouselOffers,
  convertLegacyScript,
  defaultSealCue,
  dialogueMentionsPrice,
  isCompositionOnlyChange,
  isScriptV2,
  McScriptWindowContext,
  mergeScriptProduct,
  normalizeOfferCarouselScript,
  normalizeScriptV2,
  scriptContentHash,
  validateScriptV2,
} from '../domain/mc-script-v2';
import { hasSpeechAlignment } from '../domain/mc-captions';
import { rewriteSpokenOfferLines } from '../domain/mc-director';
import { carouselPrice } from '../domain/mc-offer-carousel-props';
import {
  assertProjectTransition,
  assertSceneTransition,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
} from '../domain/mc-state-machines';
import {
  MC_OFFER_CAROUSEL_MAX_SPEECH_S,
  MC_TALKING_ART_MAX_S,
  MC_TALKING_ART_MIN_S,
  McProjectOptions,
  McScript,
  McScriptScene,
  McSceneType,
  McSealProduct,
  McStepType,
  resolveProjectOptions,
} from '../domain/mc-types';
import { ElevenLabsAlignment } from '../domain/mc-captions';
import {
  RegeneratePreviewDto,
  SelectPreviewDto,
  UpdateCompositionDto,
  UpdateDialogueV2Dto,
  UpdateScriptV2Dto,
  ApproveProductionDto,
} from '../dto/quality-v2.dto';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';
import { McTranslationService } from './mc-translation.service';

/**
 * Orquestração do PIPELINE V2 (ADR-001 §3.3/§4): roteiro → preparação de
 * prévias → revisão visual/sonora → aprovação vinculada a uma revisão
 * imutável → produção → montagem, com correção por cena e revisão
 * `assembly_only` pós-entrega.
 *
 * Invariantes que este service sustenta:
 * - Toda escrita exige `expectedRevision` (409 REVISION_CONFLICT quando
 *   difere); edição de conteúdo incrementa a revisão e invalida a aprovação.
 * - Vídeo NUNCA é submetido sem aprovação válida da revisão corrente
 *   (servidor aqui; worker em McPipelineService.claimStep/assertSubmitAllowed).
 * - Reserva/cotação/consumo/estorno por FASE, com chave de ledger própria
 *   (nunca liquidar de novo reservas históricas — ADR §4.3).
 * - Preparação inteira em cache chega a `visual_review` na mesma transação.
 * - Projetos legados (pipelineVersion 1) não entram aqui: as rotas fazem o
 *   dispatch e 422 PIPELINE_VERSION quando o executor não corresponde.
 */
/**
 * Texto falado anterior que mudou nesta edição (narração do F1 e falas por cena),
 * para o histórico do evento `script_updated`. Vazio quando nada falado mudou.
 */
export function spokenTextHistory(
  previous: McScript | null | undefined,
  next: McScript,
): {
  previousNarration?: string;
  previousDialogues?: Array<{ sceneId: string; dialogue: string }>;
} {
  if (!previous) return {};
  const out: {
    previousNarration?: string;
    previousDialogues?: Array<{ sceneId: string; dialogue: string }>;
  } = {};
  if (typeof previous.narration === 'string' && previous.narration !== next.narration) {
    out.previousNarration = previous.narration;
  }
  const nextById = new Map(next.scenes.map((sc) => [sc.sceneId, sc.dialogue ?? null]));
  const changed = (previous.scenes ?? [])
    .filter((sc) => sc.sceneId && typeof sc.dialogue === 'string')
    .filter((sc) => nextById.get(sc.sceneId as string) !== sc.dialogue)
    .map((sc) => ({ sceneId: sc.sceneId as string, dialogue: sc.dialogue as string }));
  if (changed.length > 0) out.previousDialogues = changed;
  return out;
}

@Injectable()
export class McQualityService {
  private readonly logger = new Logger(McQualityService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly settings: SystemSettingsService,
    private readonly credits: CreditsService,
    private readonly moderation: ModerationProvider,
    private readonly commercials: CommercialsService,
    private readonly materializer: McMaterializerService,
    private readonly pipeline: McPipelineService,
    private readonly translation: McTranslationService,
  ) {}

  // ───────────────────────────── roteiro (P1) ─────────────────────────────

  /**
   * PATCH script (v2): substitui o roteiro por IDENTIDADE de cena. Derivações
   * EN só sobrevivem quando a intenção pt não mudou (hash); nada é preservado
   * por posição. Incrementa a revisão e leva o projeto a storyboard_review
   * (ou a visual_review `assembly_only` quando, após a entrega, só a
   * composição mudou).
   */
  async updateScript(
    userId: string,
    projectId: string,
    dto: UpdateScriptV2Dto,
  ): Promise<McProject> {
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, dto.expectedRevision);
    this.assertStatus(project, [
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.VISUAL_REVIEW,
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.SUCCEEDED,
    ]);
    const previous = project.script;
    const prevById = new Map((previous?.scenes ?? []).map((s) => [s.sceneId as string, s]));
    const carousel = project.format === 'offer_carousel';
    // BUG B: o produto do DTO é MESCLADO com o congelado de mesmo `id` — campo
    // omitido (catálogo, unidade, foto, preço anterior, badge) nunca se perde,
    // senão todo "salvar" parecia troca de produto e mudava o escopo da revisão.
    const frozen: McSealProduct[] = previous
      ? carousel
        ? carouselOffers(previous)
        : (previous.products ?? [])
      : [];
    const knownProducts = new Map(frozen.map((p) => [p.id as string, p]));
    const sourceProducts = (carousel ? (dto.offers ?? dto.products) : dto.products) ?? frozen;
    const products = sourceProducts.map((p) =>
      mergeScriptProduct(p, p.id ? knownProducts.get(p.id) : null, () => randomUUID()),
    );
    const draft: McScript = {
      version: (previous?.version ?? 0) + 1,
      schemaVersion: MC_SCRIPT_SCHEMA_V2,
      products,
      environments: (dto.environments ?? previous?.environments ?? []).map((e) => ({
        id: e.id,
        assetId: e.assetId ?? null,
        description: e.description,
        version:
          e.version ?? (previous?.environments ?? []).find((x) => x.id === e.id)?.version ?? 1,
      })),
      scenes: dto.scenes.map((scene, position): McScriptScene => {
        const before = scene.sceneId ? prevById.get(scene.sceneId) : undefined;
        if (scene.sceneId && !before) {
          throw new UnprocessableEntityException({
            code: 'SCENE_UNKNOWN',
            message: `A cena ${scene.sceneId} não existe neste roteiro.`,
          });
        }
        // talk_tile (F1/F2) não tem selo nem área do terço inferior: sem default —
        // senão todo "salvar" inventava um selo e virava mudança de composição (BUG B).
        const talkTile = scene.sceneType === 'talk_tile';
        const next: McScriptScene = {
          idx: position,
          sceneId: scene.sceneId ?? randomUUID(),
          sceneType: scene.sceneType,
          initialFrame: scene.initialFrame?.trim() || undefined,
          camera: scene.camera ?? null,
          environmentId: scene.environmentId ?? null,
          productRef: scene.productRef,
          sealCue: talkTile
            ? scene.sealCue !== undefined
              ? scene.sealCue
              : (before?.sealCue ?? null)
            : (scene.sealCue ?? before?.sealCue ?? defaultSealCue(scene.durationS)),
          safeArea: talkTile
            ? scene.safeArea !== undefined
              ? scene.safeArea
              : (before?.safeArea ?? null)
            : (scene.safeArea ?? before?.safeArea ?? 'lower_third'),
          actionPrompt: (scene.actionPrompt ?? '').trim(),
          dialogue: scene.dialogue?.trim() ? scene.dialogue.trim() : null,
          durationS: scene.durationS,
        };
        // Derivação EN: carregada da cena ANTERIOR DE MESMA IDENTIDADE e só
        // fica válida se o hash da intenção bater (effectiveScenePrompts).
        if (before?.derived) next.derived = before.derived;
        return next;
      }),
      seal: null,
      endcard: dto.endcard === undefined ? (previous?.endcard ?? null) : dto.endcard,
      // Formato e campos do F1 (D6): o formato vem do PROJETO (nunca do DTO);
      // os demais, do DTO quando enviados, senão preservados do roteiro atual.
      ...(project.format && project.format !== 'scenes' ? { format: project.format } : {}),
      ...(dto.narration !== undefined || previous?.narration !== undefined
        ? { narration: dto.narration?.trim() || previous?.narration }
        : {}),
      ...((dto.window ?? previous?.window) ? { window: dto.window ?? previous?.window } : {}),
      ...(dto.logoFace !== undefined || previous?.logoFace !== undefined
        ? { logoFace: dto.logoFace ?? previous?.logoFace }
        : {}),
      ...((dto.citedOfferIds ?? previous?.citedOfferIds)
        ? { citedOfferIds: dto.citedOfferIds ?? previous?.citedOfferIds }
        : {}),
      ...(dto.talkBackgroundColor !== undefined
        ? { talkBackgroundColor: dto.talkBackgroundColor }
        : previous?.talkBackgroundColor !== undefined
          ? { talkBackgroundColor: previous.talkBackgroundColor }
          : {}),
      // F2 (6.6): ofertas = produtos mesclados (ordem acompanha as falas na
      // normalização), preset e legendas do DTO ou preservados; falas derivadas.
      ...(carousel
        ? {
            offers: products.map((p) => ({ ...p })),
            ...((dto.layoutPreset ?? previous?.layoutPreset)
              ? { layoutPreset: dto.layoutPreset ?? previous?.layoutPreset }
              : {}),
            ...(typeof (dto.captions ?? previous?.captions) === 'boolean'
              ? { captions: dto.captions ?? previous?.captions }
              : {}),
          }
        : {}),
    };
    // F2 (6.8): nome/preço atual de uma oferta mudou e a fala dela não ⇒ a fala
    // é reescrita pelo diretor e volta para confirmação (revisão do roteiro).
    const script = rewriteSpokenOfferLines(
      previous,
      normalizeScriptV2(draft, () => randomUUID()),
    ).script;
    // Salvar sem mudança é no-op (BUG B): mesma impressão editorial ⇒ nada de
    // revisão nova, evento ou troca de status (nem moderação).
    if (
      previous &&
      isScriptV2(previous) &&
      scriptContentHash(previous) === scriptContentHash(script)
    ) {
      return project;
    }
    const issues = validateScriptV2(script, {
      format: project.format ?? 'scenes',
      ...(await this.windowContext(project)),
    });
    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        code: 'SCRIPT_INVALID',
        message: issues[0].message,
        issues,
      });
    }
    const moderation = await this.moderateOrFail(this.scriptText(script));
    if (moderation.flagged) {
      await this.auditBlockedModeration(userId, project.id, moderation);
      throw new UnprocessableEntityException({
        code: 'SCRIPT_MODERATION_BLOCKED',
        message:
          'O novo roteiro foi bloqueado pela verificação de conteúdo. Ajuste o texto e tente novamente.',
      });
    }

    const compositionOnly =
      project.status === McProjectStatus.SUCCEEDED &&
      !!previous &&
      isScriptV2(previous) &&
      isCompositionOnlyChange(previous, script, {
        endcardChanged:
          (previous.endcard?.storeName ?? null) !== (script.endcard?.storeName ?? null),
      });
    const nextRevision = project.revision + 1;
    const target = compositionOnly
      ? McProjectStatus.VISUAL_REVIEW
      : McProjectStatus.STORYBOARD_REVIEW;

    await this.dataSource.transaction(async (manager) => {
      const quality = resolveQuality(project.quality);
      const nextQuality: McQualityState = {
        ...quality,
        approval: null,
        productionApproval: compositionOnly ? quality.productionApproval : null,
        pendingScope: compositionOnly ? 'assembly_only' : null,
        resumePhase: null,
        lastDelivery: this.recordDelivery(project, quality),
      };
      const won = await this.casTransitionWithRevision(manager, project, target, {
        script,
        revision: nextRevision,
        quality: nextQuality,
        moderation: this.moderationJson(moderation),
      });
      if (!won) throw this.conflict();
      if (project.status === McProjectStatus.SUCCEEDED && !compositionOnly) {
        // Cenas ficam prontas até a próxima preparação; a entrega anterior segue acessível.
        await this.pipeline.cancelIdleSteps(manager, project.id);
      }
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: project.id,
        kind: 'script_updated',
        fromStatus: project.status,
        toStatus: target,
        detail: {
          version: script.version,
          revision: nextRevision,
          sceneCount: script.scenes.length,
          compositionOnly,
          // Spec video-talking-art "Edição do texto": a versão anterior do texto falado
          // fica registrada no evento (só o que mudou: narração e falas por cena).
          ...spokenTextHistory(previous, script),
        },
      });
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_project', projectId: project.id, status: target, revision: nextRevision },
        MC_EVENTS_CHANNEL,
      );
    });
    return this.reload(project.id);
  }

  /**
   * POST /projects/:id/convert — conversão EXPLÍCITA de um projeto legado para
   * o pipeline v2 (ADR §5): nova revisão com roteiro convertido, entrega
   * anterior preservada em `lastDelivery`/`finalAssetId`. Só de
   * storyboard_review ou succeeded (nunca com trabalho em andamento).
   */
  async convertToV2(userId: string, projectId: string): Promise<McProject> {
    const project = await this.getOwnedProject(userId, projectId);
    if (isPipelineV2(project)) return project;
    this.assertStatus(project, [McProjectStatus.STORYBOARD_REVIEW, McProjectStatus.SUCCEEDED]);
    if (!project.script || project.script.scenes.length === 0) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_WITHOUT_SCRIPT',
        message: 'O projeto ainda não tem roteiro.',
      });
    }
    const { script, productRefsInferred } = convertLegacyScript(project.script, () => randomUUID());
    const issues = validateScriptV2(script);
    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        code: 'SCRIPT_INVALID',
        message: issues[0].message,
        issues,
      });
    }
    await this.dataSource.transaction(async (manager) => {
      const quality: McQualityState = {
        ...resolveQuality(null),
        lastDelivery: this.recordDelivery(project, resolveQuality(null)),
      };
      const won = await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        project.status,
        McProjectStatus.STORYBOARD_REVIEW,
        {
          pipelineVersion: MC_PIPELINE_V2,
          revision: project.revision + 1,
          script,
          quality,
        },
      );
      if (!won) throw this.conflict();
      await this.pipeline.cancelIdleSteps(manager, project.id);
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: project.id,
        kind: 'converted_to_v2',
        fromStatus: project.status,
        toStatus: McProjectStatus.STORYBOARD_REVIEW,
        detail: { revision: project.revision + 1, productRefsInferred },
      });
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_project', projectId: project.id, status: McProjectStatus.STORYBOARD_REVIEW },
        MC_EVENTS_CHANNEL,
      );
    });
    return this.reload(project.id);
  }

  // ─────────────────────────── cotações (P2/P3) ───────────────────────────

  /** GET /projects/:id/quote?phase= — estimativa ANTES de executar (sem reservar). */
  async quote(
    userId: string,
    projectId: string,
    phase: McPhase,
    overrides: { musicEnabled?: boolean } = {},
  ): Promise<
    McPhaseQuote & { issues: Array<{ code: string; sceneId?: string; message: string }> }
  > {
    const project = await this.getV2Project(userId, projectId);
    const script = project.script as McScript;
    const issues = validateScriptV2(script, {
      format: project.format ?? 'scenes',
      ...(await this.windowContext(project)),
    });
    const scenes = await this.dataSource
      .getRepository(McScene)
      .find({ where: { projectId: project.id } });
    const inputs = script.scenes.map((s) => {
      const row = scenes.find((r) => r.scriptSceneId === s.sceneId);
      const cached: McStepType[] = [];
      // Estimativa conservadora: só o que já está selecionado na cena conta como reaproveitável.
      if (phase === 'preparation' && row?.keyframeAssetId) cached.push(McStepType.KEYFRAME);
      if (phase === 'preparation' && row?.audioAssetId) cached.push(McStepType.TTS);
      return { sceneId: s.sceneId as string, sceneType: s.sceneType as McSceneType, cached };
    });
    // Trilha (F1/F2): a escolha ainda não gravada (`?musicEnabled=` da tela de
    // revisão) prevalece sobre a opção do projeto.
    const musicEnabled =
      overrides.musicEnabled ?? resolveProjectOptions(project.options).musicEnabled;
    return {
      ...quotePhase(phase, project.revision, inputs, { format: project.format, musicEnabled }),
      issues,
    };
  }

  // ──────────────────────────── preparação (P3) ────────────────────────────

  /**
   * POST /projects/:id/prepare — gera SOMENTE prévias (imagem/TTS) da revisão
   * corrente: moderação, derivação PT→EN, cotação, reserva da fase, CAS
   * storyboard_review → preparing, materialização e enqueue — tudo na mesma
   * transação. Cache integral ⇒ visual_review imediato.
   */
  async prepare(userId: string, projectId: string, expectedRevision: number): Promise<McProject> {
    await this.assertNotPaused();
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, expectedRevision);
    const quality = resolveQuality(project.quality);
    const resuming =
      project.status === McProjectStatus.NEEDS_ATTENTION && quality.resumePhase === 'preparation';
    if (project.status !== McProjectStatus.STORYBOARD_REVIEW && !resuming) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_NOT_PREPARABLE',
        message: `O projeto está em '${project.status}' — só roteiros em revisão (ou preparações a retomar) podem ser preparados.`,
      });
    }
    const kit = await this.getApprovedKit(project.kitId);
    const validated = this.validatedScript(project);
    const moderation = await this.moderateOrFail(this.scriptText(validated));
    if (moderation.flagged) {
      await this.auditBlockedModeration(userId, project.id, moderation);
      throw new UnprocessableEntityException({
        code: 'SCRIPT_MODERATION_BLOCKED',
        message:
          'O roteiro foi bloqueado pela verificação de conteúdo. Edite as cenas e tente novamente.',
      });
    }
    // Derivação PT→EN fora da transação (rede); o hash da intenção garante
    // que só cenas pendentes recebem derivação nova.
    const { script, translated } = await this.translation.deriveScript(validated);

    await this.dataSource.transaction(async (manager) => {
      const from = project.status;
      const startedAt = new Date().toISOString();
      const scenes = await this.materializer.syncScenesV2(
        manager,
        { ...project, script } as McProject,
        script,
        { rearm: true },
      );
      const { items } = await this.materializer.materializePreparationV2(
        manager,
        { ...project, script } as McProject,
        kit,
        script,
        scenes,
      );
      const quote: McPhaseQuote = {
        phase: 'preparation',
        revision: project.revision,
        items,
        totalCredits: items.reduce((s, i) => s + i.credits, 0),
      };
      const budget = await this.reservePhase(manager, project, quality, quote);
      const manifest = await this.materializer.buildPreparationManifest(
        manager,
        { ...project, script } as McProject,
        kit,
        script,
        scenes,
        { completed: false, startedAt },
      );
      const nextQuality: McQualityState = upsertPhaseBudget(
        {
          ...quality,
          preparation: manifest,
          approval: null,
          productionApproval: null,
          resumePhase: null,
          pendingScope: null,
        },
        budget,
      );
      assertProjectTransition(from, McProjectStatus.PREPARING);
      const won = await this.casTransitionWithRevision(
        manager,
        project,
        McProjectStatus.PREPARING,
        {
          script,
          quality: nextQuality,
          moderation: this.moderationJson(moderation),
          reservedCredits: project.reservedCredits + budget.reservedCredits,
          errorCode: null,
          errorMessage: null,
        },
      );
      if (!won) throw this.conflict();
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        from,
        McProjectStatus.PREPARING,
        {
          revision: project.revision,
          translated,
          quotedCredits: quote.totalCredits,
          cachedItems: items.filter((i) => i.cached).length,
        },
      );
      const fresh = await manager.findOneByOrFail(McProject, { id: project.id });
      const enqueued = await this.pipeline.enqueueReadySteps(manager, project.id);
      // Cache integral: nada a rodar ⇒ revisão visual na mesma transação (ADR §4.1).
      if (enqueued.length === 0) {
        await this.pipeline.completePreparationIfReady(manager, fresh, kit);
      }
    });
    return this.reload(project.id);
  }

  /**
   * POST /projects/:id/scenes/:sceneId/previews — regenerar imagem ou voz
   * (tentativa explícita, nunca devolve o cache rejeitado), orçada à parte.
   * De visual_review (ou needs_attention da preparação) ⇒ preparing.
   */
  async regeneratePreview(
    userId: string,
    projectId: string,
    sceneId: string,
    dto: RegeneratePreviewDto,
  ): Promise<McProject> {
    await this.assertNotPaused();
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, dto.expectedRevision);
    const quality = resolveQuality(project.quality);
    const resuming =
      project.status === McProjectStatus.NEEDS_ATTENTION && quality.resumePhase === 'preparation';
    if (project.status !== McProjectStatus.VISUAL_REVIEW && !resuming) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_STATE_INVALID',
        message: `Prévias só podem ser regeneradas na revisão visual (status atual: '${project.status}').`,
      });
    }
    const kit = await this.getApprovedKit(project.kitId);
    const script = this.validatedScript(project);
    const scriptScene = this.scriptSceneOrFail(script, sceneId);
    const type = dto.kind === 'image' ? McStepType.KEYFRAME : McStepType.TTS;
    if (type === McStepType.TTS && !scenePlan(scriptScene.sceneType as McSceneType).hasTts) {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_SPOKEN',
        message: 'Esta cena não tem fala.',
      });
    }
    const scene = await this.sceneRowOrFail(project.id, sceneId);

    await this.dataSource.transaction(async (manager) => {
      const from = project.status;
      const step = await this.materializer.createPreviewAttemptV2(
        manager,
        project,
        kit,
        script,
        scene,
        type,
      );
      const credits = creditsEnabled('commercials') ? MC_STEP_CREDITS[type] : 0;
      const budget =
        findPhaseBudget(quality, 'preparation', project.revision) ??
        this.emptyBudget(project, 'preparation');
      if (credits > 0) {
        await this.credits.reserve(
          manager,
          userId,
          `${budget.ledgerKey}:regen:${step.id}`,
          credits,
        );
      }
      const item: McQuoteItem = {
        sceneId,
        stepType: type,
        attempt: step.attempt,
        credits: MC_STEP_CREDITS[type],
        cached: false,
      };
      const nextBudget: McPhaseBudget = {
        ...budget,
        quotedCredits: budget.quotedCredits + MC_STEP_CREDITS[type],
        reservedCredits: budget.reservedCredits + credits,
        items: [...budget.items, item],
      };
      const nextQuality = upsertPhaseBudget(
        { ...quality, approval: null, productionApproval: null, resumePhase: null },
        nextBudget,
      );
      assertProjectTransition(from, McProjectStatus.PREPARING);
      const won = await this.casTransitionWithRevision(
        manager,
        project,
        McProjectStatus.PREPARING,
        {
          quality: nextQuality,
          reservedCredits: project.reservedCredits + credits,
          errorCode: null,
          errorMessage: null,
        },
      );
      if (!won) throw this.conflict();
      // Cena que FALHOU na preparação volta a `pending` (failed → pending é a
      // transição de correção). Sem isso ela atravessaria a revisão visual e a
      // produção ainda `failed`: o clipe final nunca a marcaria `ready` e a
      // montagem morreria em `composition_changed` (bug pego em uso real).
      await this.rearmScene(manager, userId, scene, {
        reason: 'preview_regeneration',
        stepId: step.id,
      });
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'scene',
        refId: scene.id,
        kind: 'preview_regeneration_requested',
        detail: { sceneId, type, attempt: step.attempt, stepId: step.id, credits },
      });
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        from,
        McProjectStatus.PREPARING,
        { sceneId, type, attempt: step.attempt },
      );
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });
    return this.reload(project.id);
  }

  /**
   * PATCH /projects/:id/scenes/:sceneId/dialogue (v2) — ajustar a fala na
   * revisão visual: mudança editorial (revisão++), TTS novo, vídeo de
   * voiceover preservado quando a nova locução couber (decidido na aprovação).
   */
  async updateDialogue(
    userId: string,
    projectId: string,
    sceneId: string,
    dto: UpdateDialogueV2Dto,
  ): Promise<McProject> {
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, dto.expectedRevision);
    this.assertStatus(project, [
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.VISUAL_REVIEW,
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.SUCCEEDED,
    ]);
    const script = this.validatedScript(project);
    const scriptScene = this.scriptSceneOrFail(script, sceneId);
    if (!scenePlan(scriptScene.sceneType as McSceneType).hasTts) {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_SPOKEN',
        message: 'Esta cena não tem fala — mude o tipo da cena para narrar.',
      });
    }
    const dtoScript: UpdateScriptV2Dto = {
      expectedRevision: dto.expectedRevision,
      scenes: script.scenes.map((s) => ({
        sceneId: s.sceneId,
        sceneType: s.sceneType as McSceneType,
        initialFrame: s.initialFrame,
        actionPrompt: s.actionPrompt,
        dialogue: s.sceneId === sceneId ? dto.dialogue : s.dialogue,
        durationS: s.durationS,
        productRef: s.productRef,
        sealCue: s.sealCue ?? null,
        safeArea: s.safeArea ?? null,
        camera: s.camera ?? null,
        environmentId: s.environmentId ?? null,
      })),
    };
    const updated = await this.updateScript(userId, projectId, dtoScript);
    // Da revisão visual: já preparar de novo (só o TTS da cena roda; o resto reaproveita a seleção).
    if (project.status === McProjectStatus.VISUAL_REVIEW) {
      return this.prepare(userId, projectId, updated.revision);
    }
    return updated;
  }

  /** PATCH /projects/:id/scenes/:sceneId/preview-selection — escolher entre alternativas geradas. */
  async selectPreview(
    userId: string,
    projectId: string,
    sceneId: string,
    dto: SelectPreviewDto,
  ): Promise<McProject> {
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, dto.expectedRevision);
    this.assertStatus(project, [McProjectStatus.VISUAL_REVIEW]);
    const scene = await this.sceneRowOrFail(project.id, sceneId);
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: dto.stepId });
    if (!step || step.projectId !== project.id || step.sceneId !== scene.id) {
      throw new UnprocessableEntityException({
        code: 'PREVIEW_NOT_FOUND',
        message: 'A prévia escolhida não pertence a esta cena.',
      });
    }
    if (
      ![McStepStatus.SUCCEEDED, McStepStatus.SKIPPED_CACHED].includes(step.status) ||
      !step.outputAssetId
    ) {
      throw new UnprocessableEntityException({
        code: 'PREVIEW_NOT_READY',
        message: 'A prévia escolhida ainda não está pronta.',
      });
    }
    if (step.type !== McStepType.KEYFRAME && step.type !== McStepType.TTS) {
      throw new UnprocessableEntityException({
        code: 'PREVIEW_TYPE_INVALID',
        message: 'Só imagem e voz têm alternativas.',
      });
    }
    // O asset precisa ser do usuário e continuar existente (ADR §4.1: asset apagado/expirado não é usado).
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: step.outputAssetId });
    if (!asset || asset.userId !== userId || !asset.fileUrl) {
      throw new UnprocessableEntityException({
        code: 'ASSET_UNAVAILABLE',
        message: 'A prévia escolhida não está mais disponível. Gere outra.',
      });
    }
    // Reuso entre revisões: o snapshot da tentativa precisa corresponder aos inputs correntes.
    const kit = await this.getApprovedKit(project.kitId);
    const script = this.validatedScript(project);
    await this.dataSource.transaction(async (manager) => {
      const patch: Partial<McScene> =
        step.type === McStepType.KEYFRAME
          ? { keyframeAssetId: step.outputAssetId }
          : { audioAssetId: step.outputAssetId };
      await manager.update(McScene, { id: scene.id }, patch);
      const scenes = await manager.find(McScene, {
        where: { projectId: project.id },
        order: { idx: 'ASC' },
      });
      const live = scenes.filter((s) => s.status !== McSceneStatus.CANCELED);
      const quality = resolveQuality(project.quality);
      const manifest = await this.materializer.buildPreparationManifest(
        manager,
        project,
        kit,
        script,
        live,
        { completed: true, startedAt: quality.preparation?.startedAt },
      );
      const won = await this.casTransitionWithRevision(
        manager,
        project,
        McProjectStatus.VISUAL_REVIEW,
        {
          quality: { ...quality, preparation: manifest, approval: null, productionApproval: null },
        },
      );
      if (!won) throw this.conflict();
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'scene',
        refId: scene.id,
        kind: 'preview_selected',
        detail: {
          sceneId,
          type: step.type,
          stepId: step.id,
          assetId: step.outputAssetId,
          attempt: step.attempt,
        },
      });
      await this.transitions.notify(
        manager,
        userId,
        { kind: 'mc_scene', projectId: project.id, sceneId: scene.id, status: scene.status },
        MC_EVENTS_CHANNEL,
      );
    });
    return this.reload(project.id);
  }

  // ───────────────────────────── aprovação (P3) ─────────────────────────────

  /**
   * POST /projects/:id/approve-production — o GATE de vídeo (ADR §3.3/§4.1):
   * revisão + hash do manifesto esperados, validação de durações (voiceover
   * cabe no clipe), legendas solicitadas com alinhamento (ou aceite
   * explícito), cotação da produção, reserva incremental e enqueue — CAS e
   * materialização na MESMA transação. Aprovação obsoleta falha sem gasto.
   */
  async approveProduction(
    userId: string,
    projectId: string,
    dto: ApproveProductionDto,
  ): Promise<McProject> {
    await this.assertNotPaused();
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, dto.expectedRevision);
    this.assertStatus(project, [McProjectStatus.VISUAL_REVIEW]);
    const quality = resolveQuality(project.quality);
    if (quality.pendingScope === 'assembly_only') {
      throw new UnprocessableEntityException({
        code: 'SCOPE_ASSEMBLY_ONLY',
        message: 'Esta revisão só remonta o vídeo — use a aprovação de montagem.',
      });
    }
    const manifest = quality.preparation;
    if (
      !manifest ||
      !manifest.hash ||
      manifest.revision !== project.revision ||
      !manifest.completedAt
    ) {
      throw new UnprocessableEntityException({
        code: 'PREPARATION_INCOMPLETE',
        message: 'As prévias desta revisão ainda não estão completas.',
      });
    }
    if (manifest.hash !== dto.manifestHash) {
      throw new ConflictException({
        code: 'MANIFEST_CONFLICT',
        message: 'As prévias mudaram desde a última visualização. Recarregue e revise de novo.',
        manifestHash: manifest.hash,
      });
    }
    // kit precisa estar aprovado; no talk_tile ele também define o tile e o
    // motor (tier × identidade), cujo `maxChunkS` limita cada fala (D7). O
    // motor de logo pode cair no motor do TIER no submit (indisponibilidade,
    // D2), então o limite efetivo é o MENOR entre o escolhido e o fallback.
    const kit = await this.getApprovedKit(project.kitId);
    const talkEngine = talkEngineFor({ tier: project.tier, identityMode: kit.identityMode });
    const fallbackKey = talkFallbackEngineKey(talkEngine.key, project.tier);
    const fallbackEngine = fallbackKey ? mcTalkEngines()[fallbackKey] : null;
    const talkLimitS = Math.min(
      talkEngine.maxChunkS,
      fallbackEngine?.maxChunkS ?? Number.POSITIVE_INFINITY,
    );
    const script = this.validatedScript(project, await this.windowContext(project));
    assertLogoFaceReady(project, script); // 4.6 (D9b): rosto do logo exige caixa confirmada
    const scenes = (
      await this.dataSource
        .getRepository(McScene)
        .find({ where: { projectId: project.id }, order: { idx: 'ASC' } })
    ).filter((s) => s.status !== McSceneStatus.CANCELED);

    // Assets selecionados existem, são do usuário e estão íntegros.
    const assetIds = scenes
      .flatMap((s) => [s.keyframeAssetId, s.audioAssetId])
      .filter((id): id is string => !!id);
    const assets = await this.dataSource
      .getRepository(AnimationAsset)
      .find({ where: { id: In(assetIds) } });
    const problems: Array<{
      code: string;
      sceneId: string;
      message: string;
      detail?: Record<string, unknown>;
    }> = [];
    for (const scene of scenes) {
      const scriptScene = script.scenes.find((s) => s.sceneId === scene.scriptSceneId);
      if (!scriptScene) continue;
      const plan = scenePlan(scriptScene.sceneType as McSceneType);
      const sceneId = scriptScene.sceneId as string;
      const talkTile = scriptScene.sceneType === 'talk_tile';
      if (sceneUsesKeyframe(scriptScene.sceneType as McSceneType)) {
        const keyframe = assets.find((a) => a.id === scene.keyframeAssetId);
        if (!keyframe || keyframe.userId !== userId || !keyframe.fileUrl) {
          problems.push({
            code: 'KEYFRAME_MISSING',
            sceneId,
            message: `Cena ${scriptScene.idx + 1}: imagem selecionada indisponível.`,
          });
        }
      } else if (talkTile && !kit.tileAssetId) {
        // A imagem do clipe falado é o tile do kit (D1) — sem ele não há
        // produção. Kit aprovado é IMUTÁVEL: a saída é um kit novo.
        problems.push({
          code: 'KIT_TILE_MISSING',
          sceneId,
          message:
            `Cena ${scriptScene.idx + 1}: o kit não tem tile de fala — crie um novo kit ` +
            '(ou escolha um kit aprovado depois da atualização).',
          detail: { sceneId, kitId: kit.id, actions: ['create_kit'] },
        });
      }
      if (plan.hasTts) {
        const audio = assets.find((a) => a.id === scene.audioAssetId);
        if (!audio || audio.userId !== userId || !audio.fileUrl) {
          problems.push({
            code: 'AUDIO_MISSING',
            sceneId,
            message: `Cena ${scriptScene.idx + 1}: voz selecionada indisponível.`,
          });
        } else {
          if (scriptScene.sceneType === 'action_voiceover' && audio.durationMs != null) {
            const clipS = Number(klingActionDuration(scriptScene.durationS));
            const excess = voiceoverPlanExcessMs(audio.durationMs, clipS);
            if (excess > 0) {
              problems.push({
                code: 'AUDIO_EXCEEDS_CLIP',
                sceneId,
                message: `Cena ${scriptScene.idx + 1}: a locução (${(audio.durationMs / 1000).toFixed(1)}s) não cabe no clipe de ${clipS}s. Encurte a fala ou divida a cena.`,
                detail: { audioMs: audio.durationMs, clipS, excessMs: excess },
              });
            }
          }
          // talk_tile (D7 "uma fala, um clipe"): a fala MEDIDA precisa caber
          // numa chamada do motor — nunca cortar palavras nem acelerar; o
          // usuário divide ou encurta a fala.
          if (talkTile && audio.durationMs != null) {
            const measuredS = Number((audio.durationMs / 1000).toFixed(2));
            const limitS = talkLimitS;
            if (measuredS > limitS) {
              problems.push({
                code: 'SPEECH_SENTENCE_TOO_LONG',
                sceneId,
                message: `Cena ${scriptScene.idx + 1}: a fala mede ${measuredS.toFixed(1)}s e o motor aceita até ${limitS}s por chamada. Divida a fala em duas ou encurte o texto.`,
                detail: {
                  sceneId,
                  measuredS,
                  limitS,
                  engine: talkEngine.model,
                  fallbackEngine: fallbackEngine?.model ?? null,
                  actions: ['split_speech', 'shorten_speech'],
                },
              });
            }
          }
          const options = resolveProjectOptions(project.options);
          const hasAlignment = !!(audio.metadata as { alignment?: unknown } | null)?.alignment;
          // F2: alinhamento é obrigatório para os cards (SPEECH_ALIGNMENT_MISSING,
          // abaixo, sem aceite) — o aceite de "entregar sem legenda" não se aplica.
          if (
            project.format !== 'offer_carousel' &&
            options.captionsEnabled &&
            !hasAlignment &&
            !dto.acceptMissingCaptions &&
            !quality.captionsMissingAccepted
          ) {
            problems.push({
              code: 'CAPTIONS_ALIGNMENT_MISSING',
              sceneId,
              message: `Cena ${scriptScene.idx + 1}: a voz não tem alinhamento para legenda. Regenere a voz ou aceite entregar sem legenda nesta cena.`,
            });
          }
        }
      }
    }
    // F1 (spec "Duração pela fala"): a SOMA das falas medidas fica entre 6 e
    // 25 s; fora disso bloqueia com SPEECH_DURATION_OUT_OF_RANGE até o texto
    // mudar ou o usuário aceitar explicitamente (aceite persistido, como as
    // legendas). Só com todas as falas medidas — AUDIO_MISSING já cobre o resto.
    if (project.format === 'talking_art') {
      const measured = scenes
        .map((scene) => assets.find((a) => a.id === scene.audioAssetId)?.durationMs ?? null)
        .filter((ms): ms is number => ms != null);
      if (measured.length === scenes.length && scenes.length > 0) {
        const totalS = Number((measured.reduce((sum, ms) => sum + ms, 0) / 1000).toFixed(2));
        const outOfRange = totalS < MC_TALKING_ART_MIN_S || totalS > MC_TALKING_ART_MAX_S;
        const accepted = dto.acceptSpeechDuration === true || quality.speechDurationAccepted;
        if (outOfRange && !accepted) {
          problems.push({
            code: 'SPEECH_DURATION_OUT_OF_RANGE',
            sceneId: scenes[0].scriptSceneId as string,
            message:
              totalS < MC_TALKING_ART_MIN_S
                ? `As falas somam ${totalS.toFixed(1)}s — o vídeo precisa de ${MC_TALKING_ART_MIN_S} a ${MC_TALKING_ART_MAX_S}s. Acrescente o convite ou cite mais uma oferta, ou aceite a duração.`
                : `As falas somam ${totalS.toFixed(1)}s — o vídeo precisa de ${MC_TALKING_ART_MIN_S} a ${MC_TALKING_ART_MAX_S}s. Reduza o texto ou aceite a duração.`,
            detail: {
              totalS,
              minS: MC_TALKING_ART_MIN_S,
              maxS: MC_TALKING_ART_MAX_S,
              actions: ['adjust_text', 'accept_duration'],
            },
          });
        }
      }
    }
    // F2 (tarefa 6.7, spec video-offer-carousel): cards e legendas por palavra
    // dependem dos timestamps do TTS — fala sem alinhamento bloqueia com
    // SPEECH_ALIGNMENT_MISSING (única ação: refazer o TTS da fala, SEM aceite);
    // a soma das falas MEDIDAS acima de 30 s bloqueia com SPEECH_OVER_LENGTH
    // (encurtar falas ou remover oferta, SEM aceite).
    if (project.format === 'offer_carousel') {
      problems.push(...this.offerCarouselSpeechProblems(scenes, assets));
    }
    if (problems.length > 0) {
      throw new UnprocessableEntityException({
        code: problems[0].code,
        message: problems[0].message,
        // `details` do primeiro problema no topo (ex.: {sceneId, measuredS, limitS}); a lista completa em `issues`
        ...(problems[0].detail ? { details: problems[0].detail } : {}),
        issues: problems,
      });
    }

    // Trilha escolhida na revisão (F1/F2): gravada junto da aprovação, antes de
    // materializar — o hash do `finalize` e a cotação já saem com ela.
    const currentOptions = resolveProjectOptions(project.options);
    const producedOptions: McProjectOptions =
      dto.musicEnabled === undefined
        ? currentOptions
        : { ...currentOptions, musicEnabled: dto.musicEnabled };
    const optionsChanged = producedOptions.musicEnabled !== currentOptions.musicEnabled;
    const produced: McProject = optionsChanged
      ? ({ ...project, options: producedOptions } as McProject)
      : project;
    await this.dataSource.transaction(async (manager) => {
      // Cena presa em `failed` (preparação retomada): a produção parte do zero
      // para ela — re-arma antes de materializar, senão o vídeo é produzido e
      // a cena nunca fica `ready` (a montagem cancelaria a composição).
      for (const scene of scenes) {
        await this.rearmScene(manager, userId, scene, { reason: 'production_approval' });
      }
      const { items } = await this.materializer.materializeProductionV2(
        manager,
        produced,
        script,
        scenes,
      );
      // Steps de projeto da fase assembly por formato (D6): `assembly` no F3;
      // `compose_ffmpeg` + `finalize` no F1 — cotados junto da produção (a
      // trilha do F1/F2 soma no `finalize`).
      const projectItems: McQuoteItem[] = projectAssemblyQuoteItems(project.format, {
        musicEnabled: producedOptions.musicEnabled,
      });
      const quote: McPhaseQuote = {
        phase: 'production',
        revision: project.revision,
        items: [...items, ...projectItems],
        totalCredits: [...items, ...projectItems].reduce((s, i) => s + i.credits, 0),
      };
      if (dto.budgetCredits != null && quote.totalCredits > dto.budgetCredits) {
        throw new UnprocessableEntityException({
          code: 'BUDGET_EXCEEDED',
          message: `A produção custa ${quote.totalCredits} cr, acima do limite aceito (${dto.budgetCredits} cr).`,
          quotedCredits: quote.totalCredits,
        });
      }
      const budget = await this.reservePhase(manager, project, quality, quote);
      const approval: McApprovalManifest = {
        scope: 'production',
        revision: project.revision,
        manifestHash: manifest.hash as string,
        approvedAt: new Date().toISOString(),
        userId,
        budgetCredits: quote.totalCredits,
      };
      await this.materializer.ensureAssemblyStepV2(manager, produced, script, scenes);
      const nextQuality = upsertPhaseBudget(
        {
          ...quality,
          approval,
          productionApproval: approval,
          resumePhase: null,
          captionsMissingAccepted:
            quality.captionsMissingAccepted || dto.acceptMissingCaptions === true,
          speechDurationAccepted:
            quality.speechDurationAccepted || dto.acceptSpeechDuration === true,
        },
        budget,
      );
      const won = await this.casTransitionWithRevision(
        manager,
        project,
        McProjectStatus.GENERATING,
        {
          ...(optionsChanged ? { options: producedOptions } : {}),
          quality: nextQuality,
          approvedAt: new Date(),
          reservedCredits: project.reservedCredits + budget.reservedCredits,
          errorCode: null,
          errorMessage: null,
        },
      );
      if (!won) throw this.conflict();
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        McProjectStatus.VISUAL_REVIEW,
        McProjectStatus.GENERATING,
        {
          revision: project.revision,
          manifestHash: manifest.hash,
          quotedCredits: quote.totalCredits,
          cachedItems: items.filter((i) => i.cached).length,
          musicEnabled: producedOptions.musicEnabled,
        },
      );
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });
    return this.reload(project.id);
  }

  /**
   * POST /projects/:id/scenes/:sceneId/video — refazer o vídeo de UMA cena com
   * as prévias aprovadas (needs_attention ou succeeded). Preserva a regra
   * comercial de re-roll (1º grátis; depois custo de produção da cena). A
   * aprovação da revisão continua válida (não é edição).
   */
  async rerollScene(
    userId: string,
    projectId: string,
    sceneId: string,
    expectedRevision: number,
  ): Promise<McProject> {
    await this.assertNotPaused();
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, expectedRevision);
    this.assertStatus(project, [
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.SUCCEEDED,
      McProjectStatus.GENERATING,
    ]);
    const quality = resolveQuality(project.quality);
    if (!approvalAuthorizes(quality, project.revision, 'production')) {
      throw new UnprocessableEntityException({
        code: 'APPROVAL_MISSING',
        message:
          'Esta revisão não tem produção aprovada — aprove as prévias antes de refazer um vídeo.',
      });
    }
    const script = this.validatedScript(project);
    const scriptScene = this.scriptSceneOrFail(script, sceneId);
    const scene = await this.sceneRowOrFail(project.id, sceneId);
    if (project.status === McProjectStatus.GENERATING && scene.status !== McSceneStatus.FAILED) {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_REROLLABLE',
        message: 'Esta cena ainda está em produção — espere ela terminar.',
      });
    }
    if (scene.status !== McSceneStatus.READY && scene.status !== McSceneStatus.FAILED) {
      throw new UnprocessableEntityException({
        code: 'SCENE_NOT_REROLLABLE',
        message: `A cena está em '${scene.status}'.`,
      });
    }

    await this.dataSource.transaction(async (manager) => {
      const from = project.status;
      const newCount = scene.rerollCount + 1;
      const paid = creditsEnabled('commercials') && newCount > 1;
      const amount = paid ? custoProducaoDaCena(scriptScene.sceneType as McSceneType) : 0;
      const budget =
        findPhaseBudget(quality, 'production', project.revision) ??
        this.emptyBudget(project, 'production');
      if (amount > 0)
        await this.credits.reserve(
          manager,
          userId,
          `${budget.ledgerKey}:reroll:${scene.id}:${newCount}`,
          amount,
        );
      // re-arma SEM zerar o vídeo (o cache decide); nova tentativa de produção
      await manager.update(
        McScene,
        { id: scene.id },
        {
          status: McSceneStatus.PENDING,
          finalAssetId: null,
          errorCode: null,
          errorMessage: null,
          rerollCount: newCount,
        },
      );
      scene.status = McSceneStatus.PENDING;
      scene.finalAssetId = null;
      await this.pipeline.cancelIdleSteps(manager, project.id, scene.id);
      const { items } = await this.materializer.materializeProductionV2(
        manager,
        project,
        script,
        [scene],
        { forceNewAttempt: true },
      );
      const nextBudget: McPhaseBudget = {
        ...budget,
        quotedCredits: budget.quotedCredits + items.reduce((s, i) => s + i.credits, 0),
        reservedCredits: budget.reservedCredits + amount,
        items: [...budget.items, ...items],
      };
      const nextQuality = upsertPhaseBudget(
        { ...quality, resumePhase: null, lastDelivery: this.recordDelivery(project, quality) },
        nextBudget,
      );
      const target = McProjectStatus.GENERATING;
      if (from !== target) assertProjectTransition(from, target);
      const won =
        from === target
          ? await manager
              .update(
                McProject,
                { id: project.id, revision: project.revision },
                { quality: nextQuality, reservedCredits: project.reservedCredits + amount },
              )
              .then((r) => (r.affected ?? 0) === 1)
          : await this.casTransitionWithRevision(manager, project, target, {
              quality: nextQuality,
              reservedCredits: project.reservedCredits + amount,
              errorCode: null,
              errorMessage: null,
              finishedAt: null,
            });
      if (!won) throw this.conflict();
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'scene',
        refId: scene.id,
        kind: 'reroll',
        fromStatus: McSceneStatus.READY,
        toStatus: McSceneStatus.PENDING,
        detail: { sceneId, rerollCount: newCount, paid, credits: amount },
      });
      if (from !== target)
        await this.pipeline.appendProjectTransition(manager, userId, project.id, from, target, {
          sceneId,
          reroll: newCount,
        });
      const fresh = await manager.findOneByOrFail(McProject, { id: project.id });
      const scenes = (await manager.find(McScene, { where: { projectId: project.id } })).filter(
        (s) => s.status !== McSceneStatus.CANCELED,
      );
      await this.materializer.ensureAssemblyStepV2(manager, fresh, script, scenes);
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });
    return this.reload(project.id);
  }

  // ───────────────────── composição pós-entrega (assembly_only) ─────────────────────

  /**
   * PATCH /projects/:id/composition — correção só de COMPOSIÇÃO após a entrega
   * (ou numa revisão `assembly_only` aberta): abre/atualiza a revisão
   * `assembly_only` (visual_review) SEM preparação paga nem clipe novo — a
   * aprovação de montagem refaz só os steps de projeto do formato. FORMAT-AWARE
   * (BUG A — o roteiro F1/F2 era validado como `scenes` e sempre falhava):
   * - `scenes` (F3): produtos/selos/ordem/cartela; preço também falado ⇒ 422;
   * - `talking_art` (F1): janela, cor da janela, cartela, legendas, trilha →
   *   `compose_ffmpeg` + `finalize`;
   * - `offer_carousel` (F2): preset de layout, legendas, foto/badge/unidade/
   *   preço anterior das ofertas e ordem das ofertas → `render_remotion` +
   *   `finalize`. Nome/preço atual são falados ⇒ 422 (use PATCH /offers/:id).
   */
  async updateComposition(
    userId: string,
    projectId: string,
    dto: UpdateCompositionDto,
  ): Promise<McProject> {
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, dto.expectedRevision);
    this.assertStatus(project, [McProjectStatus.SUCCEEDED, McProjectStatus.VISUAL_REVIEW]);
    const quality = resolveQuality(project.quality);
    if (
      project.status === McProjectStatus.VISUAL_REVIEW &&
      quality.pendingScope !== 'assembly_only'
    ) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_STATE_INVALID',
        message: 'Edite a composição no roteiro durante a revisão visual.',
      });
    }
    const format = project.format ?? 'scenes';
    this.assertCompositionFields(format, dto);
    const windowCtx = await this.windowContext(project);
    const previous = this.validatedScript(project, windowCtx);
    const options = resolveProjectOptions(project.options);
    const endcard = dto.endcard === undefined ? (previous.endcard ?? null) : dto.endcard;
    let script: McScript;
    if (format === 'talking_art') {
      script = {
        ...previous,
        version: previous.version + 1,
        endcard,
        ...(dto.window ? { window: { ...dto.window } } : {}),
      };
    } else if (format === 'offer_carousel') {
      script = this.offerCarouselComposition(previous, dto, options, endcard);
    } else {
      script = this.sceneComposition(previous, dto, endcard);
    }
    const issues = validateScriptV2(script, {
      format,
      aspectRatio: project.aspectRatio,
      ...windowCtx,
    });
    if (issues.length > 0)
      throw new UnprocessableEntityException({
        code: 'SCRIPT_INVALID',
        message: issues[0].message,
        issues,
      });
    if (format === 'scenes') {
      // Preço mudou E a fala cita preço ⇒ não é só composição (ADR §3.6).
      const priceChanged = (previous.products ?? []).some((p) => {
        const n = (script.products ?? []).find((x) => x.id === p.id);
        return n && n.price !== p.price;
      });
      if (priceChanged) {
        const spokenPrice = script.scenes
          .filter((s) => s.productRef && dialogueMentionsPrice(s.dialogue))
          .map((s) => s.sceneId);
        if (spokenPrice.length > 0) {
          throw new UnprocessableEntityException({
            code: 'PRICE_SPOKEN_IN_DIALOGUE',
            message: 'O preço também é falado nestas cenas — edite a fala para regravar a locução.',
            sceneIds: spokenPrice,
          });
        }
      }
    }
    if (
      !isCompositionOnlyChange(previous, script, {
        endcardChanged:
          (previous.endcard?.storeName ?? null) !== (script.endcard?.storeName ?? null),
      }) &&
      dto.musicEnabled === undefined &&
      dto.captionsEnabled === undefined &&
      dto.lowerThirdBlur === undefined
    ) {
      throw new UnprocessableEntityException({
        code: 'NO_COMPOSITION_CHANGE',
        message: 'Nada mudou na composição.',
      });
    }
    const nextOptions: McProjectOptions = {
      ...options,
      musicEnabled: dto.musicEnabled ?? options.musicEnabled,
      captionsEnabled: dto.captionsEnabled ?? options.captionsEnabled,
      lowerThirdBlur: dto.lowerThirdBlur ?? options.lowerThirdBlur,
    };
    const nextRevision = project.revision + 1;
    await this.dataSource.transaction(async (manager) => {
      const won = await this.casTransitionWithRevision(
        manager,
        project,
        McProjectStatus.VISUAL_REVIEW,
        {
          script,
          options: nextOptions,
          revision: nextRevision,
          // F2: o preset fica também na coluna do projeto (lida pela ponte/duplicação)
          ...(format === 'offer_carousel' && script.layoutPreset
            ? { layoutPreset: script.layoutPreset }
            : {}),
          quality: {
            ...quality,
            approval: null,
            pendingScope: 'assembly_only',
            resumePhase: null,
            lastDelivery: this.recordDelivery(project, quality),
          },
        },
      );
      if (!won) throw this.conflict();
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: project.id,
        kind: 'composition_updated',
        fromStatus: project.status,
        toStatus: McProjectStatus.VISUAL_REVIEW,
        detail: { revision: nextRevision, format },
      });
      await this.transitions.notify(
        manager,
        userId,
        {
          kind: 'mc_project',
          projectId: project.id,
          status: McProjectStatus.VISUAL_REVIEW,
          revision: nextRevision,
        },
        MC_EVENTS_CHANNEL,
      );
    });
    return this.reload(project.id);
  }

  /** Campos do DTO de composição que o formato NÃO tem → 422 COMPOSITION_FIELD_NOT_SUPPORTED. */
  private assertCompositionFields(format: string, dto: UpdateCompositionDto): void {
    const byFormat: Record<string, Array<keyof UpdateCompositionDto>> = {
      scenes: ['window', 'talkBackgroundColor', 'layoutPreset', 'offers', 'offerOrder'],
      // A cor do fundo do tile está gravada nos clipes de fala: trocá-la exige regravar
      // (edição do roteiro), não só remontar — por isso não é campo de composição no F1.
      talking_art: [
        'products',
        'scenes',
        'order',
        'offers',
        'offerOrder',
        'layoutPreset',
        'lowerThirdBlur',
        'talkBackgroundColor',
      ],
      offer_carousel: ['products', 'scenes', 'window', 'talkBackgroundColor', 'lowerThirdBlur'],
    };
    const fields = (byFormat[format] ?? []).filter((key) => dto[key] !== undefined);
    if (fields.length > 0) {
      throw new UnprocessableEntityException({
        code: 'COMPOSITION_FIELD_NOT_SUPPORTED',
        message: `Campo(s) de composição que o formato "${format}" não tem: ${fields.join(', ')}.`,
        details: { format, fields },
      });
    }
  }

  /** F3: selos/produtos/ordem das cenas (produtos mesclados — campos omitidos preservados). */
  private sceneComposition(
    previous: McScript,
    dto: UpdateCompositionDto,
    endcard: McScript['endcard'],
  ): McScript {
    const known = new Map((previous.products ?? []).map((p) => [p.id as string, p]));
    const products = (dto.products ?? previous.products ?? []).map((p) =>
      mergeScriptProduct(p, p.id ? known.get(p.id) : null, () => randomUUID()),
    );
    const byId = new Map(dto.scenes?.map((s) => [s.sceneId, s]) ?? []);
    let scenes = previous.scenes.map((s) => {
      const patch = byId.get(s.sceneId as string);
      if (!patch) return { ...s };
      return {
        ...s,
        productRef: patch.productRef === undefined ? s.productRef : patch.productRef,
        sealCue: patch.sealCue === undefined ? s.sealCue : patch.sealCue,
        safeArea: patch.safeArea === undefined ? s.safeArea : patch.safeArea,
      };
    });
    if (dto.order) scenes = this.reorderScenes(scenes, dto.order);
    return {
      ...previous,
      version: previous.version + 1,
      products,
      scenes: scenes.map((s, idx) => ({ ...s, idx })),
      endcard,
    };
  }

  private reorderScenes(scenes: McScriptScene[], order: string[]): McScriptScene[] {
    const known = new Set(scenes.map((s) => s.sceneId as string));
    if (
      order.length !== scenes.length ||
      new Set(order).size !== order.length ||
      order.some((id) => !known.has(id))
    ) {
      throw new UnprocessableEntityException({
        code: 'ORDER_INVALID',
        message: 'A ordem precisa listar todas as cenas exatamente uma vez.',
      });
    }
    return order.map((id, idx) => ({ ...scenes.find((s) => s.sceneId === id)!, idx }));
  }

  /**
   * F2 (6.8): composição das ofertas — foto/badge/unidade/preço anterior,
   * ordem das ofertas (as falas acompanham: abertura, ofertas na nova ordem,
   * fechamento — nenhum TTS/clipe refeito), preset e legendas. Nome/preço
   * atual diferentes do congelado ⇒ 422 OFFER_SPOKEN_FIELDS_CHANGED.
   */
  private offerCarouselComposition(
    previous: McScript,
    dto: UpdateCompositionDto,
    options: McProjectOptions,
    endcard: McScript['endcard'],
  ): McScript {
    const offers = carouselOffers(previous).map((o) => ({ ...o }));
    for (const patch of dto.offers ?? []) {
      const offer = offers.find((o) => o.id === patch.id);
      if (!offer) {
        throw new UnprocessableEntityException({
          code: 'OFFER_NOT_FOUND',
          message: `A oferta ${patch.id} não existe neste vídeo.`,
          details: { offerId: patch.id },
        });
      }
      const spoken: string[] = [];
      if (patch.name !== undefined && patch.name.trim() !== offer.name.trim()) spoken.push('name');
      if (
        patch.price !== undefined &&
        (carouselPrice(patch.price) ?? patch.price.trim()) !==
          (carouselPrice(offer.price) ?? offer.price.trim())
      ) {
        spoken.push('price');
      }
      if (spoken.length > 0) {
        throw new UnprocessableEntityException({
          code: 'OFFER_SPOKEN_FIELDS_CHANGED',
          message:
            'Nome e preço atual são falados no vídeo — a fala da oferta precisa ser refeita. ' +
            'Use "atualizar oferta".',
          details: { offerId: offer.id, fields: spoken, actions: ['update_offer'] },
        });
      }
      if (patch.imageUrl !== undefined) offer.imageUrl = patch.imageUrl;
      if (patch.badge !== undefined) offer.badge = patch.badge;
      if (patch.unit !== undefined) offer.unit = patch.unit;
      if (patch.originalPrice !== undefined) offer.originalPrice = patch.originalPrice;
    }
    let scenes = previous.scenes.map((s) => ({ ...s }));
    if (dto.order) scenes = this.reorderScenes(scenes, dto.order);
    if (dto.offerOrder) {
      const ids = offers.map((o) => o.id as string);
      if (
        dto.offerOrder.length !== ids.length ||
        new Set(dto.offerOrder).size !== ids.length ||
        dto.offerOrder.some((id) => !ids.includes(id))
      ) {
        throw new UnprocessableEntityException({
          code: 'ORDER_INVALID',
          message: 'A ordem precisa listar todas as ofertas exatamente uma vez.',
        });
      }
      const opening = scenes[0];
      const closing = scenes[scenes.length - 1];
      const offerScenes = dto.offerOrder.map((id) => scenes.find((s) => s.productRef === id));
      if (offerScenes.some((s) => !s)) {
        throw new UnprocessableEntityException({
          code: 'ORDER_INVALID',
          message: 'Toda oferta precisa da sua fala para ser reordenada.',
        });
      }
      scenes = [opening, ...(offerScenes as McScriptScene[]), closing];
    }
    return normalizeOfferCarouselScript({
      ...previous,
      version: previous.version + 1,
      offers,
      products: offers.map((o) => ({ ...o })),
      scenes: scenes.map((s, idx) => ({ ...s, idx })),
      endcard,
      layoutPreset: dto.layoutPreset ?? previous.layoutPreset,
      captions:
        dto.captionsEnabled !== undefined
          ? dto.captionsEnabled
          : typeof previous.captions === 'boolean'
            ? previous.captions
            : options.captionsEnabled,
    });
  }

  /** POST /projects/:id/approve-assembly — aprovação editorial: só montagem, com os clipes existentes. */
  async approveAssembly(
    userId: string,
    projectId: string,
    expectedRevision: number,
  ): Promise<McProject> {
    await this.assertNotPaused();
    const project = await this.getV2Project(userId, projectId);
    this.assertRevision(project, expectedRevision);
    const quality = resolveQuality(project.quality);
    const resuming =
      project.status === McProjectStatus.NEEDS_ATTENTION && quality.resumePhase === 'assembly';
    if (
      !(
        project.status === McProjectStatus.VISUAL_REVIEW && quality.pendingScope === 'assembly_only'
      ) &&
      !resuming
    ) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_STATE_INVALID',
        message: 'Não há remontagem pendente para aprovar.',
      });
    }
    const script = this.validatedScript(project);
    const scenes = (
      await this.dataSource
        .getRepository(McScene)
        .find({ where: { projectId: project.id }, order: { idx: 'ASC' } })
    ).filter((s) => s.status !== McSceneStatus.CANCELED);
    const notReady = scenes.filter((s) => s.status !== McSceneStatus.READY || !s.finalAssetId);
    if (notReady.length > 0) {
      throw new UnprocessableEntityException({
        code: 'SCENES_NOT_READY',
        message: 'Há cenas sem clipe final — a remontagem só usa clipes já aprovados.',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      const from = project.status;
      const quote = quotePhase('assembly', project.revision, [], {
        format: project.format,
        musicEnabled: resolveProjectOptions(project.options).musicEnabled,
      });
      const budget = await this.reservePhase(manager, project, quality, quote);
      const approval: McApprovalManifest = {
        scope: 'assembly_only',
        revision: project.revision,
        manifestHash: quality.preparation?.hash ?? 'assembly_only',
        approvedAt: new Date().toISOString(),
        userId,
        budgetCredits: quote.totalCredits,
      };
      await this.materializer.ensureAssemblyStepV2(manager, project, script, scenes);
      assertProjectTransition(from, McProjectStatus.ASSEMBLING);
      const won = await this.casTransitionWithRevision(
        manager,
        project,
        McProjectStatus.ASSEMBLING,
        {
          quality: upsertPhaseBudget(
            { ...quality, approval, pendingScope: null, resumePhase: null },
            budget,
          ),
          reservedCredits: project.reservedCredits + budget.reservedCredits,
          errorCode: null,
          errorMessage: null,
        },
      );
      if (!won) throw this.conflict();
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        from,
        McProjectStatus.ASSEMBLING,
        { revision: project.revision, scope: 'assembly_only' },
      );
      await this.pipeline.enqueueReadySteps(manager, project.id);
    });
    return this.reload(project.id);
  }

  // ─────────────────────────────── cancelar ───────────────────────────────

  /** POST /projects/:id/cancel (v2): cobre as fases novas, ignora efeitos tardios e concilia por fase. */
  async cancel(userId: string, projectId: string): Promise<McProject> {
    const project = await this.getV2Project(userId, projectId);
    this.assertStatus(project, [
      McProjectStatus.PREPARING,
      McProjectStatus.VISUAL_REVIEW,
      McProjectStatus.GENERATING,
      McProjectStatus.NEEDS_ATTENTION,
      McProjectStatus.ASSEMBLING,
    ]);
    await this.dataSource.transaction(async (manager) => {
      assertProjectTransition(project.status, McProjectStatus.CANCELED);
      const quality = resolveQuality(project.quality);
      const won = await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        project.status,
        McProjectStatus.CANCELED,
        { finishedAt: new Date() },
      );
      if (!won)
        throw new UnprocessableEntityException({
          code: 'PROJECT_NOT_CANCELABLE',
          message: 'O projeto mudou de estado durante o cancelamento. Recarregue.',
        });
      const canceledSteps = await this.pipeline.cancelIdleSteps(manager, project.id);
      await manager.update(
        McScene,
        { projectId: project.id, status: In([McSceneStatus.PENDING, McSceneStatus.RUNNING]) },
        { status: McSceneStatus.CANCELED },
      );
      const { refunded, budgets } = await this.refundOpenPhases(manager, userId, quality);
      await manager.update(
        McProject,
        { id: project.id },
        {
          quality: {
            ...quality,
            budgets,
            approval: null,
            lastDelivery: this.recordDelivery(project, quality),
          },
        },
      );
      await this.pipeline.appendProjectTransition(
        manager,
        userId,
        project.id,
        project.status,
        McProjectStatus.CANCELED,
        { canceledSteps, refundedCredits: refunded },
      );
    });
    return this.reload(project.id);
  }

  // ─────────────────────────────── internos ───────────────────────────────

  /**
   * Bloqueios do F2 na revisão visual (6.7): falas sem timestamps por palavra
   * (SPEECH_ALIGNMENT_MISSING, ação `regenerate_tts` por cena) e soma das
   * falas medidas acima de 30 s (SPEECH_OVER_LENGTH, durações por fala). Sem
   * aceite em nenhum dos dois — `acceptMissingCaptions`/`acceptSpeechDuration`
   * não os liberam.
   */
  private offerCarouselSpeechProblems(
    scenes: McScene[],
    assets: AnimationAsset[],
  ): Array<{ code: string; sceneId: string; message: string; detail?: Record<string, unknown> }> {
    const problems: Array<{
      code: string;
      sceneId: string;
      message: string;
      detail?: Record<string, unknown>;
    }> = [];
    const audioOf = (scene: McScene) => assets.find((a) => a.id === scene.audioAssetId) ?? null;
    const missing = scenes.filter((scene) => {
      const audio = audioOf(scene);
      if (!audio?.fileUrl) return false; // AUDIO_MISSING já cobre
      const alignment = (audio.metadata as { alignment?: ElevenLabsAlignment } | null)?.alignment;
      return !hasSpeechAlignment(alignment ?? null);
    });
    for (const scene of missing) {
      problems.push({
        code: 'SPEECH_ALIGNMENT_MISSING',
        sceneId: scene.scriptSceneId as string,
        message:
          `Fala ${scene.idx + 1}: a voz não tem os tempos de cada palavra — sem eles os cards ` +
          'e as legendas não sincronizam. Refaça a voz desta fala.',
        detail: {
          sceneId: scene.scriptSceneId,
          sceneIds: missing.map((s) => s.scriptSceneId),
          actions: ['regenerate_tts'],
        },
      });
    }
    const measured = scenes.map((scene) => ({
      sceneId: scene.scriptSceneId as string,
      ms: audioOf(scene)?.durationMs ?? null,
    }));
    if (measured.length > 0 && measured.every((m) => m.ms != null)) {
      const totalS = Number(
        (measured.reduce((sum, m) => sum + (m.ms as number), 0) / 1000).toFixed(2),
      );
      if (totalS > MC_OFFER_CAROUSEL_MAX_SPEECH_S) {
        problems.push({
          code: 'SPEECH_OVER_LENGTH',
          sceneId: measured[0].sceneId,
          message:
            `As falas somam ${totalS.toFixed(1)}s e o vídeo cabe em ${MC_OFFER_CAROUSEL_MAX_SPEECH_S}s. ` +
            'Encurte falas ou remova uma oferta.',
          detail: {
            totalS,
            maxS: MC_OFFER_CAROUSEL_MAX_SPEECH_S,
            scenes: measured.map((m) => ({
              sceneId: m.sceneId,
              measuredS: Number(((m.ms as number) / 1000).toFixed(2)),
            })),
            actions: ['shorten_speech', 'remove_offer'],
          },
        });
      }
    }
    return problems;
  }

  /** Reserva o preço fechado da fase (ledger próprio da fase/revisão) e devolve o orçamento persistível. */
  private async reservePhase(
    manager: EntityManager,
    project: McProject,
    quality: McQualityState,
    quote: McPhaseQuote,
  ): Promise<McPhaseBudget> {
    const existing = findPhaseBudget(quality, quote.phase, quote.revision);
    const ledgerKey = phaseLedgerKey(project.id, quote.phase, quote.revision);
    const enabled = creditsEnabled('commercials');
    // Repetir a mesma operação (retomada da fase na mesma revisão) não reserva de novo
    // o que já foi reservado: só a diferença positiva entre a nova cotação e a anterior.
    const alreadyReserved = existing?.reservedCredits ?? 0;
    const toReserve = enabled ? Math.max(0, quote.totalCredits - alreadyReserved) : 0;
    if (toReserve > 0) {
      await this.credits.reserve(
        manager,
        project.userId,
        existing ? `${ledgerKey}:top-up:${Date.now()}` : ledgerKey,
        toReserve,
      );
    }
    return {
      phase: quote.phase,
      revision: quote.revision,
      quotedCredits: quote.totalCredits,
      reservedCredits: alreadyReserved + toReserve,
      consumedCredits: existing?.consumedCredits ?? 0,
      refundedCredits: existing?.refundedCredits ?? 0,
      ledgerKey,
      settledAt: null,
      items: quote.items,
    };
  }

  private emptyBudget(project: McProject, phase: McPhase): McPhaseBudget {
    return {
      phase,
      revision: project.revision,
      quotedCredits: 0,
      reservedCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
      ledgerKey: phaseLedgerKey(project.id, phase, project.revision),
      settledAt: null,
      items: [],
    };
  }

  /** Estorna o não consumido de cada fase ainda aberta (idempotente por chave de fase). */
  private async refundOpenPhases(
    manager: EntityManager,
    userId: string,
    quality: McQualityState,
  ): Promise<{ refunded: number; budgets: McPhaseBudget[] }> {
    let refunded = 0;
    const budgets: McPhaseBudget[] = [];
    for (const budget of quality.budgets) {
      if (budget.settledAt) {
        budgets.push(budget);
        continue;
      }
      const amount = await this.credits.refundUnconsumed(
        manager,
        userId,
        budget.ledgerKey,
        budget.reservedCredits,
        budget.consumedCredits,
      );
      refunded += amount;
      budgets.push({
        ...budget,
        refundedCredits: budget.refundedCredits + amount,
        settledAt: new Date().toISOString(),
      });
    }
    return { refunded, budgets };
  }

  /** Preserva a última entrega válida antes de abrir nova revisão (ADR §4.1). */
  private recordDelivery(project: McProject, quality: McQualityState) {
    if (project.finalAssetId && quality.timeline && project.status === McProjectStatus.SUCCEEDED) {
      return {
        revision: project.revision,
        finalAssetId: project.finalAssetId,
        timeline: quality.timeline,
        deliveredAt: project.finishedAt?.toISOString?.() ?? new Date().toISOString(),
      };
    }
    return quality.lastDelivery;
  }

  /** CAS de status E revisão na mesma UPDATE — escrita concorrente antiga afeta 0 linhas. */
  private async casTransitionWithRevision(
    manager: EntityManager,
    project: McProject,
    to: McProjectStatus,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(McProject)
      .set({ ...patch, status: to })
      .where('id = :id AND status = :from AND revision = :revision', {
        id: project.id,
        from: project.status,
        revision: project.revision,
      })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  private conflict(): ConflictException {
    return new ConflictException({
      code: 'REVISION_CONFLICT',
      message: 'O projeto foi alterado por outra edição. Recarregue para ver a versão atual.',
    });
  }

  private assertRevision(project: McProject, expected: number): void {
    if (project.revision !== expected) {
      throw new ConflictException({
        code: 'REVISION_CONFLICT',
        message: `O projeto está na revisão ${project.revision}, não ${expected}. Recarregue para continuar.`,
        revision: project.revision,
      });
    }
  }

  private assertStatus(project: McProject, allowed: McProjectStatus[]): void {
    if (!allowed.includes(project.status)) {
      throw new UnprocessableEntityException({
        code: 'PROJECT_STATE_INVALID',
        message: `Operação indisponível com o projeto em '${project.status}'.`,
      });
    }
  }

  private validatedScript(project: McProject, windowCtx: McScriptWindowContext = {}): McScript {
    const script = project.script;
    if (!script || !isScriptV2(script)) {
      throw new UnprocessableEntityException({
        code: 'SCRIPT_NOT_V2',
        message: 'O roteiro deste projeto não está no formato do pipeline v2.',
      });
    }
    // 4.7: a janela do F1 é validada contra a área segura do aspecto do projeto
    // e, quando o tile é conhecido, contra o aspecto dele (±2%).
    const issues = validateScriptV2(script, {
      format: project.format ?? 'scenes',
      aspectRatio: project.aspectRatio,
      ...windowCtx,
    });
    if (issues.length > 0) {
      throw new UnprocessableEntityException({
        code: 'SCRIPT_INVALID',
        message: issues[0].message,
        issues,
      });
    }
    return script;
  }

  private scriptSceneOrFail(script: McScript, sceneId: string): McScriptScene {
    const scene = script.scenes.find((s) => s.sceneId === sceneId);
    if (!scene) throw new NotFoundException('Cena não encontrada no roteiro');
    return scene;
  }

  /**
   * Cena `failed` volta a `pending` (única saída válida de `failed` na máquina
   * de estados) com rastro; nos demais estados só limpa o erro exibido.
   */
  private async rearmScene(
    manager: EntityManager,
    userId: string,
    scene: McScene,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (scene.status !== McSceneStatus.FAILED) {
      if (scene.errorCode || scene.errorMessage) {
        await manager.update(McScene, { id: scene.id }, { errorCode: null, errorMessage: null });
        scene.errorCode = null;
        scene.errorMessage = null;
      }
      return;
    }
    assertSceneTransition(scene.status, McSceneStatus.PENDING);
    await manager.update(
      McScene,
      { id: scene.id },
      { status: McSceneStatus.PENDING, finalAssetId: null, errorCode: null, errorMessage: null },
    );
    await this.commercials.appendEvent(manager, {
      userId,
      refKind: 'scene',
      refId: scene.id,
      kind: 'transition',
      fromStatus: McSceneStatus.FAILED,
      toStatus: McSceneStatus.PENDING,
      detail,
    });
    scene.status = McSceneStatus.PENDING;
    scene.finalAssetId = null;
    scene.errorCode = null;
    scene.errorMessage = null;
  }

  private async sceneRowOrFail(projectId: string, sceneId: string): Promise<McScene> {
    const scene = await this.dataSource
      .getRepository(McScene)
      .findOneBy({ projectId, scriptSceneId: sceneId });
    if (!scene) throw new NotFoundException('Cena não encontrada');
    return scene;
  }

  private async getApprovedKit(kitId: string): Promise<McCharacterKit> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    if (!kit || kit.status !== McKitStatus.APPROVED) {
      throw new UnprocessableEntityException({
        code: 'KIT_NOT_APPROVED',
        message: 'O kit do mascote precisa estar aprovado.',
      });
    }
    return kit;
  }

  /**
   * Contexto da validação da janela do F1 (tarefa 4.7): aspecto de saída do
   * projeto + razão largura/altura do tile do kit. Fora do F1 (ou sem tile
   * ainda) devolve só o aspecto — a trava de aspecto fica para quando o tile existir.
   */
  private async windowContext(project: McProject): Promise<McScriptWindowContext> {
    const ctx: McScriptWindowContext = { aspectRatio: project.aspectRatio };
    if (project.format !== 'talking_art' || !project.kitId) return ctx;
    try {
      const kit = await this.dataSource
        .getRepository(McCharacterKit)
        .findOneBy({ id: project.kitId });
      if (!kit?.tileAssetId) return ctx;
      const tile = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: kit.tileAssetId });
      if (tile?.width && tile?.height) ctx.tileRatio = tile.width / tile.height;
    } catch {
      // contexto só refina a validação da janela: sem tile legível, valida só a área segura
    }
    return ctx;
  }

  private async getOwnedProject(userId: string, id: string): Promise<McProject> {
    const project = await this.dataSource.getRepository(McProject).findOneBy({ id });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    if (project.userId !== userId) throw new ForbiddenException();
    return project;
  }

  private async getV2Project(userId: string, id: string): Promise<McProject> {
    const project = await this.getOwnedProject(userId, id);
    if (!isPipelineV2(project)) {
      throw new UnprocessableEntityException({
        code: 'PIPELINE_VERSION',
        message:
          'Este comercial usa o fluxo anterior. Converta-o para o novo fluxo para usar esta ação.',
      });
    }
    return project;
  }

  private reload(id: string): Promise<McProject> {
    return this.dataSource.getRepository(McProject).findOneByOrFail({ id });
  }

  private async assertNotPaused(): Promise<void> {
    if ((await this.settings.get<boolean>(MC_PAUSED_KEY)) === true) {
      throw new HttpException(
        {
          code: 'MC_PAUSED',
          message: 'Geração de comerciais pausada temporariamente pelo administrador',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private scriptText(script: McScript): string {
    const parts = script.scenes.flatMap((s) => [
      s.initialFrame ?? '',
      s.actionPrompt,
      s.dialogue ?? '',
    ]);
    if (script.narration) parts.push(script.narration);
    for (const product of script.products ?? []) parts.push(product.name);
    if (script.endcard?.storeName) parts.push(script.endcard.storeName);
    return parts.filter(Boolean).join('\n');
  }

  private async moderateOrFail(text: string): Promise<ModerationResult> {
    try {
      return await this.moderation.moderate({ text });
    } catch (err) {
      this.logger.error(`Moderação indisponível: ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        code: 'MODERATION_UNAVAILABLE',
        message: 'Não foi possível verificar o conteúdo agora. Tente novamente em instantes.',
      });
    }
  }

  private async auditBlockedModeration(
    userId: string,
    projectId: string,
    moderation: ModerationResult,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        McProject,
        { id: projectId },
        { moderation: this.moderationJson(moderation) },
      );
      await this.commercials.appendEvent(manager, {
        userId,
        refKind: 'project',
        refId: projectId,
        kind: 'moderation_blocked',
        detail: { categories: moderation.categories },
      });
    });
  }

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

  /** Exposto para o pipeline: preparação concluída (sucesso/cache) ⇒ visual_review + manifesto assinado. */
  static preparationDone(
    project: Pick<McProject, 'revision'>,
    scenes: McScene[],
    steps: McStep[],
  ): boolean {
    return preparationComplete(project, scenes, steps);
  }
}
