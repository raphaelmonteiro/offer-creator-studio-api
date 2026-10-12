import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { CommercialsService } from '../commercials.service';
import { computeContentHash } from '../domain/input-hash';
import { projectAssemblySteps, scenePlan, sceneUsesKeyframe } from '../domain/mc-execution-plan';
import { MC_FINALIZE_GRAPH_VERSION, MC_FINALIZE_LOUDNESS } from '../domain/mc-finalize-graph';
import { klingActionDuration, talkEngineFor } from '../domain/mc-pipeline.config';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { MC_TALK_GAP_MS } from '../domain/mc-talk-conform-graph';
import { readProjectLogoBox } from '../domain/mc-logo-face';
import { composeHashWindow, MC_COMPOSE_GRAPH_VERSION } from '../domain/mc-talking-art-graph';
import { compositionDimensions } from '../domain/mc-composition.config';
import {
  McPhase,
  McPreparationManifest,
  McPreparationScene,
  McQuoteItem,
  McSelectedReference,
} from '../domain/mc-quality';
import { keyframeReferenceLimit, selectReferences } from '../domain/mc-references';
import { effectiveScenePrompts } from '../domain/mc-script-v2';
import { buildTalkPrompt } from '../domain/mc-talk-prompts';
import { kitVoiceDelivery } from '../domain/mc-voice-delivery';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import {
  computeAssemblyHash,
  computeAssemblyHashV2,
  computeComposeFfmpegHash,
  computeFinalizeHash,
  computeKeyframeHashV2,
  computeLipsyncHashV2,
  computeSceneComposeHash,
  computeSceneStepHashes,
  computeTalkHashV2,
  computeTtsHashV2,
  computeVideoHashV2,
  isSpokenScene,
} from '../domain/mc-step-hashes';
import {
  McScript,
  McScriptScene,
  McSceneType,
  McStepType,
  resolveProjectOptions,
} from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';

/**
 * Materialização do roteiro em cenas/steps executáveis (plano-comerciais
 * §6.1/§6.3) — usada pela aprovação do storyboard (geração 1), pelo re-roll e
 * pela regravação de fala (gerações N+1). Sempre dentro da transação do
 * chamador.
 *
 * LEGADO (pipelineVersion 1):
 * - Cena FALADA → keyframe + tts + lipsync, e um step `video` criado JÁ como
 *   `skipped_cached`: no fluxo audio-driven o Kling AI Avatar substitui o step
 *   de vídeo (gera movimento+fala direto do keyframe+áudio, plano §5.3); o
 *   scheduler exige `video` satisfeito antes do lipsync e `skipped_cached`
 *   conta como sucesso (DONE_STEP_STATUSES).
 * - Cena MUDA → keyframe + video (o video é o final da cena).
 * - CACHE por input_hash (§6.3): keyframe e tts com hash já resolvido por um
 *   step `succeeded` DO MESMO USUÁRIO nascem `skipped_cached` apontando o
 *   asset — o lookup vive AQUI (materialização), nunca no processor.
 * - skipped_cached carrega o costCredits de tabela mas NUNCA consome (§6.3).
 *
 * PIPELINE V2 (ADR-001 §3.3/§4.2) — métodos `*V2`:
 * - `syncScenesV2`: linhas de mc_scenes seguem a IDENTIDADE (`scriptSceneId`),
 *   não a posição; reordenar só muda `idx`.
 * - `materializePreparationV2`: cria os steps de PREPARAÇÃO do plano do tipo
 *   (keyframe/tts) para a revisão corrente. Reuso seletivo: se a cena já tem
 *   um asset SELECIONADO produzido com os mesmos inputs (baseHash), o step
 *   nasce `skipped_cached` apontando esse asset; senão, nova tentativa com
 *   lookup de cache por hash.
 * - `materializeProductionV2`: cria os steps de PRODUÇÃO a partir dos assets
 *   aprovados (hash com os assets selecionados, não com o hash do step).
 * - `buildPreparationManifest`: manifesto com assets, hashes, durações medidas
 *   e referências — o que a aprovação assina.
 */
@Injectable()
export class McMaterializerService {
  constructor(private readonly commercials: CommercialsService) {}

  /**
   * Lookup de cache (§6.3): step `succeeded` mais recente com o MESMO hash, do
   * MESMO usuário (escopo via join no projeto), com asset de saída.
   */
  async findCachedOutput(
    manager: EntityManager,
    userId: string,
    type: McStepType,
    inputHash: string,
  ): Promise<{ stepId: string; outputAssetId: string } | null> {
    const row = await manager
      .createQueryBuilder(McStep, 's')
      .innerJoin(McProject, 'p', 'p.id = s."projectId"')
      .where('p."userId" = :userId', { userId })
      .andWhere('s.type = :type', { type })
      .andWhere('s."inputHash" = :inputHash', { inputHash })
      .andWhere('s.status = :status', { status: McStepStatus.SUCCEEDED })
      .andWhere('s."outputAssetId" IS NOT NULL')
      .orderBy('s."createdAt"', 'DESC')
      .select(['s.id', 's.outputAssetId'])
      .getOne();
    return row ? { stepId: row.id, outputAssetId: row.outputAssetId as string } : null;
  }

  // ──────────────────────────────── legado ────────────────────────────────

  /**
   * Cria as cenas da geração 1 a partir do roteiro aprovado + os steps de cada
   * uma + o step de assembly (1 por projeto). Retorna as cenas criadas.
   */
  async materializeApproval(
    manager: EntityManager,
    project: McProject,
    kit: McCharacterKit,
    script: McScript,
  ): Promise<McScene[]> {
    const scenes: McScene[] = [];
    for (const [position, scriptScene] of script.scenes.entries()) {
      const scene = manager.create(McScene, {
        projectId: project.id,
        idx: position,
        generation: 1,
        rerollCount: 0,
        status: McSceneStatus.PENDING,
        durationS: scriptScene.durationS,
        actionPrompt: scriptScene.actionPrompt,
        dialogue: isSpokenScene(scriptScene) ? scriptScene.dialogue : null,
      });
      await manager.save(scene);
      scenes.push(scene);
      await this.createSceneSteps(manager, project, kit, scene);
    }
    await this.ensureAssemblyStep(manager, project, scenes, script);
    return scenes;
  }

  /**
   * Cria os steps da GERAÇÃO CORRENTE de uma cena (approve, re-roll ou
   * regravação de fala — o mesmo caminho para os três: o cache decide o que
   * vira skipped_cached e o audio-driven decide o video da cena falada).
   */
  async createSceneSteps(
    manager: EntityManager,
    project: McProject,
    kit: McCharacterKit,
    scene: McScene,
  ): Promise<McStep[]> {
    const spoken = isSpokenScene(scene);
    const hashes = computeSceneStepHashes({
      kitId: kit.id,
      kitVersion: kit.version,
      voiceId: kit.voiceId,
      aspectRatio: project.aspectRatio,
      actionPrompt: scene.actionPrompt,
      dialogue: scene.dialogue,
      durationS: scene.durationS,
      generation: scene.generation,
      style: kit.style ?? null, // D5: estilo fixo do kit invalida o keyframe
    });
    const steps: McStep[] = [];

    // keyframe — cacheable (§6.3): mesma ação+kit ⇒ mesmo hash entre gerações.
    steps.push(
      await this.createStep(manager, project, scene, McStepType.KEYFRAME, hashes.keyframe, {
        cacheLookup: true,
      }),
    );

    if (spoken) {
      // tts — cacheable: regravar fala muda o hash e invalida SÓ tts+lipsync.
      steps.push(
        await this.createStep(manager, project, scene, McStepType.TTS, hashes.tts as string, {
          cacheLookup: true,
        }),
      );
      // video — SEMPRE skipped_cached na cena falada (audio-driven, ver doc da
      // classe). Aponta o asset corrente da cena quando existir (re-roll).
      steps.push(
        await this.createStep(manager, project, scene, McStepType.VIDEO, hashes.video, {
          forceSkipped: true,
          skippedAssetId: scene.videoAssetId,
          skippedReason: 'audio_driven',
        }),
      );
      steps.push(
        await this.createStep(
          manager,
          project,
          scene,
          McStepType.LIPSYNC,
          hashes.lipsync as string,
          {},
        ),
      );
    } else {
      steps.push(
        await this.createStep(manager, project, scene, McStepType.VIDEO, hashes.video, {}),
      );
    }
    return steps;
  }

  /**
   * Garante UM step de assembly pendente com o hash da composição corrente:
   * cria na aprovação; recria após re-roll/edição (o anterior, succeeded, fica
   * na trilha); atualiza o hash se já existe um pendente.
   */
  async ensureAssemblyStep(
    manager: EntityManager,
    project: McProject,
    scenes: Array<Pick<McScene, 'idx' | 'generation'>>,
    script: Pick<McScript, 'seal' | 'endcard'>,
  ): Promise<McStep> {
    const options = resolveProjectOptions(project.options);
    const inputHash = computeAssemblyHash(scenes, script.seal ?? null, project.aspectRatio, {
      endcard: script.endcard ?? null,
      musicEnabled: options.musicEnabled,
      captionsEnabled: options.captionsEnabled,
    });
    return this.upsertPendingAssembly(manager, project, inputHash, null, null);
  }

  // ─────────────────────────────── pipeline v2 ───────────────────────────────

  /**
   * Sincroniza mc_scenes com o roteiro v2 pela IDENTIDADE (`scriptSceneId`):
   * cria as novas, atualiza texto/tipo/duração das existentes, reordena `idx`
   * (em duas fases, por causa do UNIQUE(projectId, idx)) e cancela as que
   * saíram do roteiro. `rearm: true` devolve todas as cenas vivas a `pending`
   * (nova revisão → nova preparação/produção); os assets selecionados ficam
   * na linha e o reuso é decidido pelos hashes.
   */
  async syncScenesV2(
    manager: EntityManager,
    project: McProject,
    script: McScript,
    opts: { rearm: boolean },
  ): Promise<McScene[]> {
    const existing = await manager.find(McScene, { where: { projectId: project.id } });
    const byScriptId = new Map(
      existing.filter((s) => s.scriptSceneId).map((s) => [s.scriptSceneId as string, s]),
    );
    const wanted = new Set(script.scenes.map((s) => s.sceneId as string));

    // 1) cancelar cenas removidas (e liberar o idx para valores negativos únicos)
    let negative = -10_000;
    for (const scene of existing) {
      if (scene.scriptSceneId && wanted.has(scene.scriptSceneId)) continue;
      negative -= 1;
      const patch: Partial<McScene> = { idx: negative };
      if (scene.status !== McSceneStatus.CANCELED) {
        patch.status = McSceneStatus.CANCELED;
        await manager.update(
          McStep,
          { sceneId: scene.id, status: In([McStepStatus.PENDING, McStepStatus.QUEUED]) },
          { status: McStepStatus.CANCELED, finishedAt: new Date() },
        );
      }
      await manager.update(McScene, { id: scene.id }, patch);
    }

    // 2) fase A: idx temporário negativo nas cenas vivas existentes
    const live: McScene[] = [];
    for (const [position, scriptScene] of script.scenes.entries()) {
      const row = byScriptId.get(scriptScene.sceneId as string);
      if (row) {
        await manager.update(McScene, { id: row.id }, { idx: -(position + 1) });
        row.idx = -(position + 1);
      }
    }

    // 3) fase B: campos + idx final; criação das novas
    for (const [position, scriptScene] of script.scenes.entries()) {
      const sceneType = scriptScene.sceneType as McSceneType;
      const dialogue = scenePlan(sceneType).hasTts ? scriptScene.dialogue : null;
      const row = byScriptId.get(scriptScene.sceneId as string);
      if (row) {
        const wasCanceled = row.status === McSceneStatus.CANCELED;
        const patch: Partial<McScene> = {
          idx: position,
          sceneType,
          actionPrompt: scriptScene.actionPrompt,
          dialogue,
          durationS: scriptScene.durationS,
        };
        if (wasCanceled) {
          patch.status = McSceneStatus.PENDING;
          patch.generation = row.generation + 1;
          patch.finalAssetId = null;
          patch.errorCode = null;
          patch.errorMessage = null;
        } else if (opts.rearm && row.status !== McSceneStatus.PENDING) {
          patch.status = McSceneStatus.PENDING;
          patch.finalAssetId = null;
          patch.errorCode = null;
          patch.errorMessage = null;
        }
        await manager.update(McScene, { id: row.id }, patch);
        Object.assign(row, patch);
        live.push(row);
      } else {
        const created = manager.create(McScene, {
          projectId: project.id,
          idx: position,
          scriptSceneId: scriptScene.sceneId,
          sceneType,
          generation: 1,
          rerollCount: 0,
          status: McSceneStatus.PENDING,
          durationS: scriptScene.durationS,
          actionPrompt: scriptScene.actionPrompt,
          dialogue,
        });
        await manager.save(created);
        live.push(created);
      }
    }
    return live.sort((a, b) => a.idx - b.idx);
  }

  /** Referências do kit com slot (para a seleção por função). */
  async kitReferencesWithSlots(
    manager: EntityManager,
    kit: McCharacterKit,
  ): Promise<Array<{ assetId: string; slot: number | null }>> {
    if (kit.referenceAssetIds.length === 0) return [];
    const assets = await manager.find(AnimationAsset, { where: { id: In(kit.referenceAssetIds) } });
    return assets
      .filter((a) => !!a.fileUrl)
      .map((a) => ({
        assetId: a.id,
        slot: typeof a.metadata?.slot === 'number' ? (a.metadata.slot as number) : null,
      }));
  }

  /**
   * Inputs de PREPARAÇÃO de uma cena v2 (o que o keyframe/TTS efetivamente
   * recebem) — a mesma função alimenta o hash, o snapshot do step e o
   * manifesto, para que os três nunca divirjam.
   */
  buildPreparationInputs(
    project: McProject,
    kit: McCharacterKit,
    script: McScript,
    scriptScene: McScriptScene,
    kitReferences: Array<{ assetId: string; slot: number | null }>,
  ): {
    prompts: NonNullable<ReturnType<typeof effectiveScenePrompts>>;
    references: McSelectedReference[];
    environment: { id: string; version: number; assetId: string | null } | null;
    keyframeBase: Omit<Parameters<typeof computeKeyframeHashV2>[0], 'attempt'>;
    tts: { dialogue: string; voiceId: string | null } | null;
    /** Nome do produto anunciado quando a cena leva a foto real dele (vai ao prompt). */
    productName: string | null;
  } {
    const prompts = effectiveScenePrompts(scriptScene);
    if (!prompts) {
      throw new Error(
        `Cena ${scriptScene.sceneId}: derivação pendente — traduzir antes de preparar`,
      );
    }
    const environment =
      (script.environments ?? []).find((e) => e.id === scriptScene.environmentId) ?? null;
    const product = scriptScene.productRef
      ? ((script.products ?? []).find((p) => p.id === scriptScene.productRef) ?? null)
      : null;
    const references = selectReferences({
      sceneType: scriptScene.sceneType as McSceneType,
      hasProduct: !!scriptScene.productRef,
      productImageUrl: product?.imageUrl ?? null,
      motionPrompt: prompts.motion,
      camera: scriptScene.camera ?? null,
      kitReferences,
      environmentAssetId: environment?.assetId ?? null,
      includeOriginal: process.env.MC_KEYFRAME_INCLUDE_ORIGINAL === 'true',
      originalAssetId: kit.cutoutAssetId,
      maxReferences: keyframeReferenceLimit(),
    });
    const plan = scenePlan(scriptScene.sceneType as McSceneType);
    return {
      prompts,
      references,
      environment: environment
        ? { id: environment.id, version: environment.version, assetId: environment.assetId }
        : null,
      keyframeBase: {
        kitId: kit.id,
        kitVersion: kit.version,
        style: kit.style ?? null, // D5: só entra no hash quando definido
        aspectRatio: project.aspectRatio,
        initialFramePrompt: prompts.initialFrame,
        promptLang: prompts.lang,
        references,
        environment: environment
          ? { id: environment.id, version: environment.version, assetId: environment.assetId }
          : null,
      },
      tts:
        plan.hasTts && scriptScene.dialogue
          ? { dialogue: scriptScene.dialogue, voiceId: kit.voiceId }
          : null,
      productName: product?.imageUrl ? product.name : null,
    };
  }

  /**
   * Inputs de preparação de uma cena SEM keyframe (`talk_tile`, D6/D7): só a
   * fala e a voz. O `keyframeBase` nunca é usado (o plano não tem keyframe),
   * mas mantém o mesmo contrato de retorno para o laço de materialização.
   */
  private buildTtsOnlyInputs(
    kit: McCharacterKit,
    scriptScene: McScriptScene,
  ): ReturnType<McMaterializerService['buildPreparationInputs']> {
    const prompts = effectiveScenePrompts(scriptScene) ?? {
      initialFrame: '',
      motion: (scriptScene.actionPrompt ?? '').trim(),
      lang: 'pt' as const,
      provider: 'none',
    };
    return {
      prompts,
      references: [],
      environment: null,
      keyframeBase: {
        kitId: kit.id,
        kitVersion: kit.version,
        style: kit.style ?? null,
        aspectRatio: '',
        initialFramePrompt: '',
        promptLang: prompts.lang,
        references: [],
        environment: null,
      },
      tts: scriptScene.dialogue ? { dialogue: scriptScene.dialogue, voiceId: kit.voiceId } : null,
      productName: null,
    };
  }

  /**
   * Materializa a PREPARAÇÃO da revisão corrente: para cada cena viva e cada
   * step de preparação do plano, reuso seletivo (asset selecionado com o mesmo
   * baseHash) → skipped_cached; senão nova tentativa (attempt = última + 1)
   * com lookup de cache por hash. Devolve os itens para a cotação.
   */
  async materializePreparationV2(
    manager: EntityManager,
    project: McProject,
    kit: McCharacterKit,
    script: McScript,
    scenes: McScene[],
  ): Promise<{ steps: McStep[]; items: McQuoteItem[] }> {
    const kitReferences = await this.kitReferencesWithSlots(manager, kit);
    const steps: McStep[] = [];
    const items: McQuoteItem[] = [];
    for (const scene of scenes) {
      const scriptScene = script.scenes.find((s) => s.sceneId === scene.scriptSceneId);
      if (!scriptScene) continue;
      const plan = scenePlan(scriptScene.sceneType as McSceneType);
      // talk_tile (D6): só TTS — nada de prompt de keyframe, referências ou
      // derivação obrigatória; a imagem é o tile do kit.
      const inputs = sceneUsesKeyframe(scriptScene.sceneType as McSceneType)
        ? this.buildPreparationInputs(project, kit, script, scriptScene, kitReferences)
        : this.buildTtsOnlyInputs(kit, scriptScene);

      for (const type of plan.preparation) {
        const baseHash =
          type === McStepType.KEYFRAME
            ? computeKeyframeHashV2({ ...inputs.keyframeBase, attempt: 0 })
            : computeTtsHashV2({
                delivery: kitVoiceDelivery(kit),
                dialogue: inputs.tts?.dialogue ?? '',
                voiceId: inputs.tts?.voiceId ?? null,
                attempt: 0,
              });
        const selectedAssetId =
          type === McStepType.KEYFRAME ? scene.keyframeAssetId : scene.audioAssetId;
        const reusable = selectedAssetId
          ? await this.selectedAssetMatches(manager, scene, type, selectedAssetId, baseHash)
          : null;
        const attempt = reusable?.attempt ?? (await this.nextAttempt(manager, scene, type));
        const inputHash =
          type === McStepType.KEYFRAME
            ? computeKeyframeHashV2({ ...inputs.keyframeBase, attempt })
            : computeTtsHashV2({
                delivery: kitVoiceDelivery(kit),
                dialogue: inputs.tts?.dialogue ?? '',
                voiceId: inputs.tts?.voiceId ?? null,
                attempt,
              });
        const snapshot: Record<string, unknown> =
          type === McStepType.KEYFRAME
            ? {
                baseHash,
                prompt: inputs.prompts.initialFrame,
                motion: inputs.prompts.motion,
                lang: inputs.prompts.lang,
                references: inputs.references,
                environment: inputs.environment,
                aspectRatio: project.aspectRatio,
                kitVersion: kit.version,
                safeArea: scriptScene.safeArea ?? null,
                productName: inputs.productName,
              }
            : {
                baseHash,
                dialogue: inputs.tts?.dialogue,
                voiceId: inputs.tts?.voiceId ?? null,
                plannedDurationS: scriptScene.durationS,
              };
        const step = await this.createStep(manager, project, scene, type, inputHash, {
          cacheLookup: !reusable,
          forceSkipped: !!reusable,
          skippedAssetId: reusable?.assetId ?? null,
          skippedReason: reusable ? 'selected_asset_reused' : undefined,
          phase: 'preparation',
          attempt,
          projectRevision: project.revision,
          inputSnapshot: snapshot,
        });
        steps.push(step);
        const cached = step.status === McStepStatus.SKIPPED_CACHED;
        items.push({
          sceneId: scene.scriptSceneId as string,
          stepType: type,
          attempt,
          credits: cached ? 0 : MC_STEP_CREDITS[type],
          cached,
        });
      }
    }
    return { steps, items };
  }

  /**
   * Regeneração EXPLÍCITA de uma prévia (imagem ou voz): nova tentativa
   * (attempt+1 ⇒ hash novo ⇒ nunca devolve a imagem rejeitada do cache),
   * alternativas anteriores preservadas nos steps antigos.
   */
  async createPreviewAttemptV2(
    manager: EntityManager,
    project: McProject,
    kit: McCharacterKit,
    script: McScript,
    scene: McScene,
    type: McStepType.KEYFRAME | McStepType.TTS,
  ): Promise<McStep> {
    const scriptScene = script.scenes.find((s) => s.sceneId === scene.scriptSceneId);
    if (!scriptScene) throw new Error('Cena não encontrada no roteiro');
    const inputs = sceneUsesKeyframe(scriptScene.sceneType as McSceneType)
      ? this.buildPreparationInputs(
          project,
          kit,
          script,
          scriptScene,
          await this.kitReferencesWithSlots(manager, kit),
        )
      : this.buildTtsOnlyInputs(kit, scriptScene);
    const attempt = await this.nextAttempt(manager, scene, type);
    const baseHash =
      type === McStepType.KEYFRAME
        ? computeKeyframeHashV2({ ...inputs.keyframeBase, attempt: 0 })
        : computeTtsHashV2({
            delivery: kitVoiceDelivery(kit),
            dialogue: inputs.tts?.dialogue ?? '',
            voiceId: inputs.tts?.voiceId ?? null,
            attempt: 0,
          });
    const inputHash =
      type === McStepType.KEYFRAME
        ? computeKeyframeHashV2({ ...inputs.keyframeBase, attempt })
        : computeTtsHashV2({
            delivery: kitVoiceDelivery(kit),
            dialogue: inputs.tts?.dialogue ?? '',
            voiceId: inputs.tts?.voiceId ?? null,
            attempt,
          });
    const snapshot: Record<string, unknown> =
      type === McStepType.KEYFRAME
        ? {
            baseHash,
            prompt: inputs.prompts.initialFrame,
            motion: inputs.prompts.motion,
            lang: inputs.prompts.lang,
            references: inputs.references,
            environment: inputs.environment,
            aspectRatio: project.aspectRatio,
            kitVersion: kit.version,
            safeArea: scriptScene.safeArea ?? null,
            productName: inputs.productName,
          }
        : {
            baseHash,
            dialogue: inputs.tts?.dialogue,
            voiceId: inputs.tts?.voiceId ?? null,
            plannedDurationS: scriptScene.durationS,
          };
    return this.createStep(manager, project, scene, type, inputHash, {
      cacheLookup: false, // regeneração explícita nunca reaproveita
      phase: 'preparation',
      attempt,
      projectRevision: project.revision,
      inputSnapshot: snapshot,
    });
  }

  /**
   * Materializa a PRODUÇÃO da revisão aprovada a partir dos assets
   * SELECIONADOS: video (action/voiceover), lipsync (presenter) e
   * scene_compose (voiceover). Cache por hash reaproveita vídeo aprovado
   * quando keyframe/movimento/duração não mudaram (regravar locução de
   * voiceover preserva o vídeo). Final em cache ⇒ cena pronta na hora.
   */
  async materializeProductionV2(
    manager: EntityManager,
    project: McProject,
    script: McScript,
    scenes: McScene[],
    opts: { onlySceneIds?: string[]; forceNewAttempt?: boolean } = {},
  ): Promise<{ steps: McStep[]; items: McQuoteItem[] }> {
    const steps: McStep[] = [];
    const items: McQuoteItem[] = [];
    // talk_tile (D1/D2): o kit entra na produção (tile, cor de fundo e modo
    // de identidade decidem a imagem e o motor) — carregado uma vez, só se
    // alguma cena precisa.
    let talkContext: Awaited<ReturnType<McMaterializerService['talkProductionContext']>> | null =
      null;
    for (const scene of scenes) {
      if (opts.onlySceneIds && !opts.onlySceneIds.includes(scene.scriptSceneId as string)) continue;
      const scriptScene = script.scenes.find((s) => s.sceneId === scene.scriptSceneId);
      if (!scriptScene) continue;
      const plan = scenePlan(scriptScene.sceneType as McSceneType);
      const usesKeyframe = sceneUsesKeyframe(scriptScene.sceneType as McSceneType);
      const prompts = usesKeyframe
        ? effectiveScenePrompts(scriptScene)
        : (effectiveScenePrompts(scriptScene) ?? {
            initialFrame: '',
            motion: (scriptScene.actionPrompt ?? '').trim(),
            lang: 'pt' as const,
            provider: 'none',
          });
      if (!prompts) throw new Error(`Cena ${scriptScene.sceneId}: derivação pendente`);
      if (usesKeyframe && !scene.keyframeAssetId)
        throw new Error(`Cena ${scriptScene.sceneId}: sem keyframe selecionado`);
      if (plan.hasTts && !scene.audioAssetId)
        throw new Error(`Cena ${scriptScene.sceneId}: sem áudio selecionado`);
      if (plan.production.includes(McStepType.TALK) && !talkContext) {
        talkContext = await this.talkProductionContext(manager, project, script);
      }

      const providerDuration = klingActionDuration(scene.durationS);
      let videoStep: McStep | null = null;
      for (const type of plan.production) {
        const attempt = opts.forceNewAttempt
          ? await this.nextAttempt(manager, scene, type)
          : await this.currentOrFirstAttempt(manager, scene, type);
        let inputHash: string;
        let snapshot: Record<string, unknown>;
        if (type === McStepType.TALK) {
          // Clipe falado a partir do TILE (D1/D2/D7): hash com motor, tile,
          // áudio, prompt e cor da janela; o snapshot carrega o que o submit
          // e o ingest precisam sem reler o kit (motor efetivo é gravado
          // pelo submit em caso de fallback).
          const ctx = talkContext as NonNullable<typeof talkContext>;
          const prompt = buildTalkPrompt(prompts.motion);
          inputHash = computeTalkHashV2({
            engineModel: ctx.engine.model,
            tileAssetId: ctx.tileAssetId,
            audioAssetId: scene.audioAssetId as string,
            prompt,
            backgroundColor: ctx.backgroundColor,
            attempt,
          });
          snapshot = {
            tileAssetId: ctx.tileAssetId,
            tileWidth: ctx.tileWidth,
            tileHeight: ctx.tileHeight,
            audioAssetId: scene.audioAssetId,
            backgroundColor: ctx.backgroundColor,
            motion: prompts.motion,
            lang: prompts.lang,
            prompt,
            engine: ctx.engine,
            tier: ctx.tier,
            identityMode: ctx.identityMode,
            sceneType: scriptScene.sceneType,
          };
        } else if (type === McStepType.VIDEO) {
          inputHash = computeVideoHashV2({
            keyframeAssetId: scene.keyframeAssetId,
            motionPrompt: prompts.motion,
            promptLang: prompts.lang,
            providerDuration,
            attempt,
          });
          snapshot = {
            keyframeAssetId: scene.keyframeAssetId,
            motion: prompts.motion,
            lang: prompts.lang,
            providerDuration,
            sceneType: scriptScene.sceneType,
          };
        } else if (type === McStepType.LIPSYNC) {
          // Avatar com prompt de movimento (ADR §3.1, adendo 18/09): a ação
          // simples da cena falada vai ao Kling Avatar — entra no hash e no snapshot.
          inputHash = computeLipsyncHashV2({
            keyframeAssetId: scene.keyframeAssetId,
            audioAssetId: scene.audioAssetId as string,
            motionPrompt: prompts.motion,
            promptLang: prompts.lang,
            attempt,
          });
          snapshot = {
            keyframeAssetId: scene.keyframeAssetId,
            audioAssetId: scene.audioAssetId,
            motion: prompts.motion,
            lang: prompts.lang,
            sceneType: scriptScene.sceneType,
          };
        } else if (type === McStepType.SCENE_COMPOSE) {
          // depende do vídeo desta produção: se o vídeo veio do cache, o asset já é conhecido
          const videoAssetId = videoStep?.outputAssetId ?? null;
          inputHash = computeSceneComposeHash({
            videoAssetId: videoAssetId ?? `step:${videoStep?.id}`,
            audioAssetId: scene.audioAssetId as string,
            plannedDurationS: scene.durationS,
          });
          snapshot = {
            videoStepId: videoStep?.id ?? null,
            videoAssetId,
            audioAssetId: scene.audioAssetId,
            plannedDurationS: scene.durationS,
            sceneType: scriptScene.sceneType,
          };
        } else {
          continue;
        }
        const step = await this.createStep(manager, project, scene, type, inputHash, {
          cacheLookup:
            !opts.forceNewAttempt &&
            (type === McStepType.VIDEO ||
              type === McStepType.LIPSYNC ||
              type === McStepType.TALK ||
              (type === McStepType.SCENE_COMPOSE && !!videoStep?.outputAssetId)),
          phase: 'production',
          attempt,
          projectRevision: project.revision,
          inputSnapshot: snapshot,
        });
        if (type === McStepType.VIDEO) videoStep = step;
        steps.push(step);
        const cached = step.status === McStepStatus.SKIPPED_CACHED;
        items.push({
          sceneId: scene.scriptSceneId as string,
          stepType: type,
          attempt,
          credits: cached ? 0 : MC_STEP_CREDITS[type],
          cached,
        });
        if (type === plan.final && cached && step.outputAssetId) {
          // final reaproveitado: cena pronta sem job (ADR §4.1: cache válido conta como conclusão)
          await manager.update(
            McScene,
            { id: scene.id },
            {
              status: McSceneStatus.READY,
              finalAssetId: step.outputAssetId,
              errorCode: null,
              errorMessage: null,
            },
          );
          scene.status = McSceneStatus.READY;
          scene.finalAssetId = step.outputAssetId;
        }
      }
    }
    return { steps, items };
  }

  /**
   * Contexto de produção do `talk` (D1/D2): tile do kit (com dimensões, para
   * o recorte de aspecto no ingest), cor da janela (`script.talkBackgroundColor`
   * → `kit.tileBackgroundColor`), motor por tier × modo de identidade. Kit sem
   * tile é erro de pré-condição (a aprovação já recusa com KIT_TILE_MISSING).
   */
  async talkProductionContext(
    manager: EntityManager,
    project: McProject,
    script: McScript,
  ): Promise<{
    tileAssetId: string;
    tileWidth: number | null;
    tileHeight: number | null;
    backgroundColor: string;
    tier: McProject['tier'];
    identityMode: McCharacterKit['identityMode'];
    engine: { key: string; model: string; usdPerSecond: number; maxChunkS: number };
  }> {
    const kit = await manager.findOne(McCharacterKit, { where: { id: project.kitId } });
    if (!kit) throw new Error(`Kit ${project.kitId} não encontrado`);
    if (!kit.tileAssetId)
      throw new Error(`Kit ${kit.id} sem tile de fala (aprovar o kit gera o tile)`);
    const tile = await manager.findOne(AnimationAsset, { where: { id: kit.tileAssetId } });
    const tier = project.tier ?? 'economico';
    const identityMode = kit.identityMode ?? 'generated';
    const engine = talkEngineFor({ tier, identityMode });
    const backgroundColor = (
      script.talkBackgroundColor?.trim() ||
      kit.tileBackgroundColor?.trim() ||
      '#FFFFFF'
    ).toUpperCase();
    return {
      tileAssetId: kit.tileAssetId,
      tileWidth: tile?.width ?? null,
      tileHeight: tile?.height ?? null,
      backgroundColor,
      tier,
      identityMode,
      engine: {
        key: engine.key,
        model: engine.model,
        usdPerSecond: engine.usdPerSecond,
        maxChunkS: engine.maxChunkS,
      },
    };
  }

  /**
   * Steps de PROJETO da fase assembly da revisão corrente, por formato (D6):
   * `scenes` → um `assembly` (montagem 720p); `talking_art` → a cadeia
   * `compose_ffmpeg → finalize`. Devolve o PRIMEIRO step da cadeia (o que o
   * scheduler destrava quando todas as cenas estão prontas).
   */
  async ensureAssemblyStepV2(
    manager: EntityManager,
    project: McProject,
    script: McScript,
    scenes: McScene[],
  ): Promise<McStep> {
    if (project.format === 'talking_art') {
      return this.ensureTalkingArtProjectStepsV2(manager, project, script, scenes);
    }
    return this.ensureSceneAssemblyStepV2(manager, project, script, scenes);
  }

  /**
   * F1 (D6/D7): `compose_ffmpeg` (hash dos clipes conformados + arte + janela +
   * cor + silêncio + legendas + cartela + versão do grafo) e `finalize` (hash
   * do compose + canal + trilha/legendas + loudness + versão do grafo). Os dois
   * nascem pendentes com o MESMO `attempt` (uma entrega = uma cadeia; o
   * scheduler só destrava o finalize pelo compose da mesma cadeia). Pendentes
   * existentes só têm o hash atualizado.
   */
  async ensureTalkingArtProjectStepsV2(
    manager: EntityManager,
    project: McProject,
    script: McScript,
    scenes: McScene[],
  ): Promise<McStep> {
    const options = resolveProjectOptions(project.options);
    const kit = await manager.findOne(McCharacterKit, { where: { id: project.kitId } });
    const backgroundColor = (
      script.talkBackgroundColor?.trim() ||
      kit?.tileBackgroundColor?.trim() ||
      '#FFFFFF'
    ).toUpperCase();
    // Janela RESOLVIDA (rosto do logo: caixa do projeto mapeada pelo contain-fit
    // da arte) — mover a caixa invalida a composição.
    const logoFace = script.logoFace === true;
    const logoBox = logoFace ? readProjectLogoBox(project.logoBox) : null;
    const art =
      logoBox && project.backgroundArtAssetId
        ? await manager.findOne(AnimationAsset, { where: { id: project.backgroundArtAssetId } })
        : null;
    // (só o modo rosto do logo usa o quadro: a caixa passa pelo contain-fit)
    const frame = logoBox ? compositionDimensions(project.aspectRatio) : { width: 1, height: 1 };
    const composeHash = computeComposeFfmpegHash({
      clips: scenes.map((s) => ({
        sceneId: s.scriptSceneId as string,
        finalAssetId: s.finalAssetId ?? `pending:${s.generation}`,
      })),
      backgroundArtAssetId: project.backgroundArtAssetId ?? null,
      aspectRatio: project.aspectRatio,
      window: composeHashWindow({
        window: script.window ?? null,
        logoFace,
        logoBox,
        artWidth: art?.width ?? null,
        artHeight: art?.height ?? null,
        width: frame.width,
        height: frame.height,
      }),
      logoFace,
      backgroundColor,
      gapMs: MC_TALK_GAP_MS,
      captionsEnabled: options.captionsEnabled,
      endcard: script.endcard?.storeName ?? null,
      graphVersion: MC_COMPOSE_GRAPH_VERSION,
    });
    const finalizeHash = computeFinalizeHash({
      composeHash,
      channel: project.channel ?? null,
      musicEnabled: options.musicEnabled,
      captionsEnabled: options.captionsEnabled,
      loudness: { ...MC_FINALIZE_LOUDNESS },
      graphVersion: MC_FINALIZE_GRAPH_VERSION,
    });
    const chain = projectAssemblySteps(project.format);
    const hashes: Partial<Record<McStepType, string>> = {
      [McStepType.COMPOSE_FFMPEG]: composeHash,
      [McStepType.FINALIZE]: finalizeHash,
    };
    // tentativa comum da cadeia: a pendente existente, ou a próxima
    const existing = await manager.find(McStep, {
      where: { projectId: project.id, type: In([...chain]) },
    });
    const pendingAttempt = existing.find((s) => s.status === McStepStatus.PENDING)?.attempt;
    const attempt =
      pendingAttempt ?? existing.reduce((max, s) => Math.max(max, s.attempt ?? 1), 0) + 1;
    let first: McStep | null = null;
    for (const type of chain) {
      const step = await this.upsertPendingProjectStep(
        manager,
        project,
        type,
        hashes[type] as string,
        'assembly',
        project.revision,
        attempt,
      );
      first = first ?? step;
    }
    return first as McStep;
  }

  /** Assembly v2 (F3): hash do CONTEÚDO renderizado (identidade de cena, finais, selos, cartela, opções). */
  private async ensureSceneAssemblyStepV2(
    manager: EntityManager,
    project: McProject,
    script: McScript,
    scenes: McScene[],
  ): Promise<McStep> {
    const options = resolveProjectOptions(project.options);
    const seals = scenes
      .map((scene) => {
        const scriptScene = script.scenes.find((s) => s.sceneId === scene.scriptSceneId);
        const product = scriptScene?.productRef
          ? (script.products ?? []).find((p) => p.id === scriptScene.productRef)
          : null;
        if (!scriptScene || !product) return null;
        const cue = scriptScene.sealCue ?? {
          startS: scriptScene.durationS / 2,
          endS: scriptScene.durationS,
        };
        return {
          sceneId: scene.scriptSceneId as string,
          productId: product.id as string,
          name: product.name,
          price: product.price,
          unit: product.unit ?? null,
          startS: cue.startS,
          endS: cue.endS,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    const inputHash = computeAssemblyHashV2({
      scenes: scenes.map((s) => ({
        sceneId: s.scriptSceneId as string,
        finalAssetId: s.finalAssetId ?? `pending:${s.generation}`,
      })),
      seals,
      endcard: script.endcard?.storeName ?? null,
      musicEnabled: options.musicEnabled,
      captionsEnabled: options.captionsEnabled,
      aspectRatio: project.aspectRatio,
    });
    return this.upsertPendingAssembly(manager, project, inputHash, 'assembly', project.revision);
  }

  /** Manifesto de preparação (ADR §4): assets selecionados, hashes, durações medidas e referências. */
  async buildPreparationManifest(
    manager: EntityManager,
    project: McProject,
    kit: McCharacterKit,
    script: McScript,
    scenes: McScene[],
    opts: { completed: boolean; startedAt?: string },
  ): Promise<McPreparationManifest> {
    const audioIds = scenes.map((s) => s.audioAssetId).filter((id): id is string => !!id);
    const audios =
      audioIds.length > 0
        ? await manager.find(AnimationAsset, { where: { id: In(audioIds) } })
        : [];
    const steps = await manager.find(McStep, {
      where: { projectId: project.id, phase: 'preparation' },
    });
    const manifestScenes: McPreparationScene[] = [];
    for (const scene of scenes) {
      const scriptScene = script.scenes.find((s) => s.sceneId === scene.scriptSceneId);
      if (!scriptScene) continue;
      const prompts = effectiveScenePrompts(scriptScene);
      const audio = audios.find((a) => a.id === scene.audioAssetId) ?? null;
      const keyframeStep = this.stepForAsset(
        steps,
        scene,
        McStepType.KEYFRAME,
        scene.keyframeAssetId,
      );
      const ttsStep = this.stepForAsset(steps, scene, McStepType.TTS, scene.audioAssetId);
      const snapshot = (keyframeStep?.inputSnapshot ?? {}) as {
        references?: McSelectedReference[];
        environment?: { id: string; version: number } | null;
        lang?: 'en' | 'pt';
        prompt?: string;
        motion?: string;
      };
      manifestScenes.push({
        sceneId: scriptScene.sceneId as string,
        sceneType: scriptScene.sceneType as McSceneType,
        keyframeAssetId: scene.keyframeAssetId,
        audioAssetId: scene.audioAssetId,
        audioDurationMs: audio?.durationMs ?? null,
        plannedDurationS: scriptScene.durationS,
        keyframeHash: keyframeStep?.inputHash ?? '',
        ttsHash: ttsStep?.inputHash ?? null,
        promptLang: snapshot.lang ?? prompts?.lang ?? 'pt',
        initialFramePrompt: snapshot.prompt ?? prompts?.initialFrame ?? '',
        motionPrompt: snapshot.motion ?? prompts?.motion ?? '',
        references: snapshot.references ?? [],
        environmentId: snapshot.environment?.id ?? scriptScene.environmentId ?? null,
        environmentVersion: snapshot.environment?.version ?? null,
        productRef: scriptScene.productRef ?? null,
      });
    }
    const manifest: McPreparationManifest = {
      revision: project.revision,
      kitId: kit.id,
      kitVersion: kit.version,
      aspectRatio: project.aspectRatio,
      scenes: manifestScenes,
      startedAt: opts.startedAt ?? new Date().toISOString(),
      completedAt: opts.completed ? new Date().toISOString() : null,
      hash: null,
    };
    if (opts.completed) manifest.hash = McMaterializerService.manifestHash(manifest);
    return manifest;
  }

  /** Hash do manifesto: o que a aprovação assina (assets, hashes, durações, prompts, produtos). */
  static manifestHash(manifest: McPreparationManifest): string {
    return computeContentHash({
      revision: manifest.revision,
      kitId: manifest.kitId,
      kitVersion: manifest.kitVersion,
      aspectRatio: manifest.aspectRatio,
      scenes: manifest.scenes.map((s) => ({
        sceneId: s.sceneId,
        sceneType: s.sceneType,
        keyframeAssetId: s.keyframeAssetId,
        audioAssetId: s.audioAssetId,
        audioDurationMs: s.audioDurationMs,
        plannedDurationS: s.plannedDurationS,
        keyframeHash: s.keyframeHash,
        ttsHash: s.ttsHash,
        promptLang: s.promptLang,
        initialFramePrompt: s.initialFramePrompt,
        motionPrompt: s.motionPrompt,
        references: s.references.map((r) => r.assetId),
        environmentId: s.environmentId,
        environmentVersion: s.environmentVersion,
        productRef: s.productRef,
      })),
    });
  }

  // ─────────────────────────────── interno ───────────────────────────────

  private stepForAsset(
    steps: McStep[],
    scene: McScene,
    type: McStepType,
    assetId: string | null,
  ): McStep | null {
    if (!assetId) return null;
    const candidates = steps.filter(
      (s) => s.sceneId === scene.id && s.type === type && s.outputAssetId === assetId,
    );
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => (b.attempt ?? 1) - (a.attempt ?? 1))[0];
  }

  /** O asset selecionado foi produzido com os MESMOS inputs (baseHash)? Então é reaproveitável. */
  private async selectedAssetMatches(
    manager: EntityManager,
    scene: McScene,
    type: McStepType,
    assetId: string,
    baseHash: string,
  ): Promise<{ assetId: string; attempt: number } | null> {
    const rows = await manager.find(McStep, {
      where: { sceneId: scene.id, type, outputAssetId: assetId },
    });
    const match = rows.find(
      (r) => (r.inputSnapshot as { baseHash?: string } | null)?.baseHash === baseHash,
    );
    return match ? { assetId, attempt: match.attempt ?? 1 } : null;
  }

  private async nextAttempt(
    manager: EntityManager,
    scene: McScene,
    type: McStepType,
  ): Promise<number> {
    const rows = await manager.find(McStep, { where: { sceneId: scene.id, type } });
    const max = rows.reduce((m, r) => Math.max(m, r.attempt ?? 1), 0);
    return max + 1;
  }

  /** Produção: primeira tentativa = 1 (cache pode reaproveitar); senão a tentativa corrente. */
  private async currentOrFirstAttempt(
    manager: EntityManager,
    scene: McScene,
    type: McStepType,
  ): Promise<number> {
    const rows = await manager.find(McStep, { where: { sceneId: scene.id, type } });
    const max = rows.reduce((m, r) => Math.max(m, r.attempt ?? 1), 0);
    return Math.max(1, max);
  }

  private upsertPendingAssembly(
    manager: EntityManager,
    project: McProject,
    inputHash: string,
    phase: McPhase | null,
    projectRevision: number | null,
  ): Promise<McStep> {
    return this.upsertPendingProjectStep(
      manager,
      project,
      McStepType.ASSEMBLY,
      inputHash,
      phase,
      projectRevision,
      1,
    );
  }

  /**
   * Garante UM step de projeto (`sceneId = null`) PENDENTE do tipo com o hash
   * corrente: atualiza hash/revisão do pendente existente ou cria outro (o
   * anterior, concluído, fica na trilha). `attempt` identifica a cadeia da
   * entrega nos formatos novos (compose + finalize com o mesmo valor).
   */
  private async upsertPendingProjectStep(
    manager: EntityManager,
    project: McProject,
    type: McStepType,
    inputHash: string,
    phase: McPhase | null,
    projectRevision: number | null,
    attempt: number,
  ): Promise<McStep> {
    const pending = await manager.findOne(McStep, {
      where: { projectId: project.id, type, status: McStepStatus.PENDING },
    });
    if (pending) {
      const patch: Partial<McStep> = {};
      if (pending.inputHash !== inputHash) patch.inputHash = inputHash;
      if (projectRevision != null && pending.projectRevision !== projectRevision)
        patch.projectRevision = projectRevision;
      if ((pending.attempt ?? 1) !== attempt) patch.attempt = attempt;
      if (Object.keys(patch).length > 0) {
        await manager.update(McStep, { id: pending.id }, patch);
        Object.assign(pending, patch);
      }
      return pending;
    }
    const step = manager.create(McStep, {
      projectId: project.id,
      sceneId: null,
      sceneGeneration: null,
      type,
      status: McStepStatus.PENDING,
      inputHash,
      costCredits: MC_STEP_CREDITS[type],
      phase,
      projectRevision,
      attempt,
    });
    await manager.save(step);
    return step;
  }

  private async createStep(
    manager: EntityManager,
    project: McProject,
    scene: McScene,
    type: McStepType,
    inputHash: string,
    opts: {
      cacheLookup?: boolean;
      forceSkipped?: boolean;
      skippedAssetId?: string | null;
      skippedReason?: string;
      phase?: McPhase | null;
      attempt?: number;
      projectRevision?: number | null;
      inputSnapshot?: Record<string, unknown> | null;
    },
  ): Promise<McStep> {
    let skipped = false;
    let outputAssetId: string | null = null;
    let cachedFromStepId: string | null = null;

    if (opts.forceSkipped) {
      skipped = true;
      outputAssetId = opts.skippedAssetId ?? null;
    } else if (opts.cacheLookup) {
      const cached = await this.findCachedOutput(manager, project.userId, type, inputHash);
      if (cached) {
        skipped = true;
        outputAssetId = cached.outputAssetId;
        cachedFromStepId = cached.stepId;
      }
    }

    const step = manager.create(McStep, {
      projectId: project.id,
      sceneId: scene.id,
      sceneGeneration: scene.generation,
      type,
      status: skipped ? McStepStatus.SKIPPED_CACHED : McStepStatus.PENDING,
      inputHash,
      outputAssetId,
      costCredits: MC_STEP_CREDITS[type],
      phase: opts.phase ?? null,
      attempt: opts.attempt ?? 1,
      projectRevision: opts.projectRevision ?? null,
      inputSnapshot: opts.inputSnapshot ?? null,
      ...(skipped ? { finishedAt: new Date() } : {}),
    });
    await manager.save(step);

    if (skipped) {
      // Atalho da cena acompanha o asset reaproveitado (processors a jusante
      // leem keyframe/audio dos atalhos da cena).
      if (outputAssetId) {
        if (type === McStepType.KEYFRAME) {
          await manager.update(McScene, { id: scene.id }, { keyframeAssetId: outputAssetId });
          scene.keyframeAssetId = outputAssetId;
        }
        if (type === McStepType.TTS) {
          await manager.update(McScene, { id: scene.id }, { audioAssetId: outputAssetId });
          scene.audioAssetId = outputAssetId;
        }
        if (type === McStepType.VIDEO) {
          await manager.update(McScene, { id: scene.id }, { videoAssetId: outputAssetId });
          scene.videoAssetId = outputAssetId;
        }
      }
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: step.id,
        kind: 'transition',
        fromStatus: McStepStatus.PENDING,
        toStatus: McStepStatus.SKIPPED_CACHED,
        detail: {
          type,
          reason: opts.skippedReason ?? 'cache_hit',
          ...(cachedFromStepId ? { cachedFromStepId } : {}),
          outputAssetId,
          ...(opts.phase ? { phase: opts.phase, attempt: opts.attempt ?? 1 } : {}),
        },
      });
    }
    return step;
  }
}
