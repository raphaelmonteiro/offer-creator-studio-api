import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CommercialsService } from '../commercials.service';
import {
  computeAssemblyHash,
  computeSceneStepHashes,
  isSpokenScene,
} from '../domain/mc-step-hashes';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType, resolveProjectOptions } from '../domain/mc-types';
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
 * Regras centrais:
 * - Cena FALADA → keyframe + tts + lipsync, e um step `video` criado JÁ como
 *   `skipped_cached`: no fluxo audio-driven o Kling AI Avatar substitui o step
 *   de vídeo (gera movimento+fala direto do keyframe+áudio, plano §5.3); o
 *   scheduler exige `video` satisfeito antes do lipsync e `skipped_cached`
 *   conta como sucesso (DONE_STEP_STATUSES) — a topologia fica intacta para a
 *   v1 plugar um motor de vídeo dedicado sem mexer no grafo.
 * - Cena MUDA → keyframe + video (o video é o final da cena).
 * - CACHE por input_hash (§6.3): keyframe e tts com hash já resolvido por um
 *   step `succeeded` DO MESMO USUÁRIO nascem `skipped_cached` apontando o
 *   asset — o lookup vive AQUI (materialização), nunca no processor. video/
 *   lipsync têm a geração no hash e nunca casam entre gerações (re-roll refaz
 *   só eles, §6.3).
 * - skipped_cached carrega o costCredits de tabela mas NUNCA consome (§6.3:
 *   cache não entra na cobrança).
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
    const pending = await manager.findOne(McStep, {
      where: { projectId: project.id, type: McStepType.ASSEMBLY, status: McStepStatus.PENDING },
    });
    if (pending) {
      if (pending.inputHash !== inputHash) {
        await manager.update(McStep, { id: pending.id }, { inputHash });
        pending.inputHash = inputHash;
      }
      return pending;
    }
    const step = manager.create(McStep, {
      projectId: project.id,
      sceneId: null,
      sceneGeneration: null,
      type: McStepType.ASSEMBLY,
      status: McStepStatus.PENDING,
      inputHash,
      costCredits: MC_STEP_CREDITS[McStepType.ASSEMBLY],
    });
    await manager.save(step);
    return step;
  }

  // ─────────────────────────────── interno ───────────────────────────────

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
        },
      });
    }
    return step;
  }
}
