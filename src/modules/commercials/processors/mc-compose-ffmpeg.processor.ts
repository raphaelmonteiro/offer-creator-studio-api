import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { buildConcatListContent } from '../domain/mc-assembly-graph';
import { compositionDimensions } from '../domain/mc-composition.config';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { MC_TALK_GAP_MS } from '../domain/mc-talk-conform-graph';
import { readProjectLogoBox } from '../domain/mc-logo-face';
import {
  buildComposeGraph,
  ComposeGraphInput,
  composedOutputIssue,
  composeHashWindow,
  composeTimeline,
  MC_COMPOSE_GRAPH_VERSION,
} from '../domain/mc-talking-art-graph';
import { defaultCharacterWindow, isWindowWellFormed } from '../domain/mc-talking-art-window';
import { McScript, McStepType, resolveProjectOptions } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/** Cor da janela quando nem o roteiro nem o kit definem uma. */
const DEFAULT_WINDOW_COLOR = '#FFFFFF';

/**
 * Consumer do step de projeto `compose_ffmpeg` (fila mc.ffmpeg, gate
 * ResourceGuard — change video-formatos-personagem, D6/D7): os clipes
 * conformados das falas, em ordem de cena, viram o vídeo COMPOSTO do formato
 * "arte que fala" nas dimensões de saída (`compositionDimensions`), com os
 * instantes de cada fala pela timeline das durações medidas + silêncios
 * (`buildSpeechTimeline`).
 *
 * O grafo vem inteiro de `buildComposeGraph(input)` (domain/mc-talking-art-
 * graph: arte contain-fit + janela com crossfade + TTS por fala): este
 * processor só resolve as ENTRADAS (assets, arte e suas dimensões, janela,
 * cor), executa os passes, verifica o arquivo e publica o asset
 * `commercial_composed`. No modo rosto do logo a janela vem da caixa
 * CONFIRMADA do projeto (`project.logoBox`, frações da arte) no momento da
 * composição — nunca da cópia gravada no roteiro. O snapshot de entrada fica
 * no step (`inputSnapshot`) e a timeline + janela resolvida no asset, para o
 * `finalize` (legendas fora da janela, `quality.timeline`) sem recalcular.
 */
@Injectable()
export class McComposeFfmpegProcessor {
  private readonly logger = new Logger(McComposeFfmpegProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly transitions: TaskTransitionService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.COMPOSE_FFMPEG);
    if (!step) return;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!project) return;

    const scenes = (
      await this.dataSource.getRepository(McScene).find({
        where: { projectId: project.id },
        order: { idx: 'ASC' },
      })
    ).filter((s) => s.status !== McSceneStatus.CANCELED);

    // Re-roll/cancel no meio do caminho: composição mudou — este step morre em
    // silêncio (o fluxo de edição cria outra cadeia pendente).
    if (
      scenes.length === 0 ||
      scenes.some((s) => s.status !== McSceneStatus.READY || !s.finalAssetId)
    ) {
      await this.dataSource.transaction((m) =>
        this.transitions.casTransition(
          m,
          McStep,
          stepId,
          McStepStatus.RUNNING,
          McStepStatus.CANCELED,
          { finishedAt: new Date(), errorCode: 'composition_changed' },
        ),
      );
      return;
    }

    const tempDir = await this.ffmpeg.createTempDir('mc-compose-');
    try {
      const script = (project.script ?? null) as McScript | null;
      const options = resolveProjectOptions(project.options);
      const { width, height } = compositionDimensions(project.aspectRatio);
      const assets = await this.dataSource.getRepository(AnimationAsset).find({
        where: { id: In(scenes.map((s) => s.finalAssetId as string)) },
      });

      // 1) clipes conformados (vídeo + TTS) na ordem de cena, com duração MEDIDA
      const measured: Array<{
        sceneId: string;
        finalAssetId: string;
        path: string;
        fileUrl: string;
        durationMs: number;
      }> = [];
      for (const scene of scenes) {
        const asset = assets.find((a) => a.id === scene.finalAssetId);
        const absolute = asset?.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null;
        if (!asset || !absolute) {
          throw new TerminalProviderError(
            `Clipe da cena ${scene.idx + 1} ausente no disco`,
            'scene_asset_missing',
          );
        }
        const probe = await this.ffmpeg.probe(absolute);
        if (!probe.hasVideo || !probe.hasAudio) {
          throw new TerminalProviderError(
            `Clipe da cena ${scene.idx + 1} sem vídeo ou sem áudio`,
            'invalid_scene_clip',
          );
        }
        measured.push({
          sceneId: scene.scriptSceneId ?? scene.id,
          finalAssetId: asset.id,
          path: absolute,
          fileUrl: asset.fileUrl as string,
          durationMs: probe.durationMs ?? asset.durationMs ?? scene.durationS * 1000,
        });
      }
      const timeline = composeTimeline(measured, MC_TALK_GAP_MS);

      // 2) arte de fundo, janela e cor (D1/D6/D9)
      const art = project.backgroundArtAssetId
        ? await this.dataSource
            .getRepository(AnimationAsset)
            .findOneBy({ id: project.backgroundArtAssetId })
        : null;
      if (project.backgroundArtAssetId && !art?.fileUrl) {
        throw new TerminalProviderError(
          'Arte de fundo do projeto ausente',
          'background_art_missing',
        );
      }
      const backgroundArtPath = art?.fileUrl ? this.storage.absoluteFromUrl(art.fileUrl) : null;
      const artDims = backgroundArtPath
        ? await this.artDimensions(backgroundArtPath, art?.width ?? null, art?.height ?? null)
        : null;
      // Modo rosto do logo: a janela é a caixa CONFIRMADA do projeto (frações da
      // arte), lida agora — um PUT logo-box depois do roteiro vale aqui.
      const logoFace = script?.logoFace === true;
      const projectLogoBox = logoFace ? readProjectLogoBox(project.logoBox) : null;
      if (logoFace && !projectLogoBox?.logoBoxConfirmed) {
        throw new TerminalProviderError(
          'Modo rosto do logo sem caixa do logo confirmada',
          'logo_box_unconfirmed',
        );
      }
      const logoBox = projectLogoBox
        ? { x: projectLogoBox.x, y: projectLogoBox.y, w: projectLogoBox.w, h: projectLogoBox.h }
        : null;
      const kit = await this.dataSource
        .getRepository(McCharacterKit)
        .findOneBy({ id: project.kitId });
      const backgroundColor = (
        script?.talkBackgroundColor?.trim() ||
        kit?.tileBackgroundColor?.trim() ||
        DEFAULT_WINDOW_COLOR
      ).toUpperCase();
      const window = isWindowWellFormed(script?.window)
        ? script!.window!
        : defaultCharacterWindow({
            width,
            height,
            tileWidth: null,
            tileHeight: null,
          });

      const input: ComposeGraphInput = {
        format: project.format ?? 'talking_art',
        aspectRatio: project.aspectRatio,
        width,
        height,
        backgroundArtPath,
        artWidth: artDims?.width ?? null,
        artHeight: artDims?.height ?? null,
        window,
        logoFace,
        logoBox,
        backgroundColor,
        fill: 'color', // TODO(4.8): escolha "arte desfocada" ainda sem campo persistido no projeto
        clips: measured.map((clip, i) => ({
          sceneId: clip.sceneId,
          path: clip.path,
          startS: timeline.clips[i].startS,
          endS: timeline.clips[i].endS,
        })),
        gapMs: MC_TALK_GAP_MS,
        captionsEnabled: options.captionsEnabled,
        endcard: script?.endcard?.storeName?.trim()
          ? { storeName: script.endcard.storeName.trim() }
          : null,
      };

      const resolvedWindow = composeHashWindow({
        window,
        logoFace,
        logoBox,
        artWidth: input.artWidth,
        artHeight: input.artHeight,
        width,
        height,
      });

      // 3) grafo + execução dos passes com progresso
      const plan = buildComposeGraph(input, tempDir);
      const totalMs = plan.passes.reduce((sum, p) => sum + p.durationMs, 0) || 1;
      let doneMs = 0;
      for (const pass of plan.passes) {
        if (pass.label === 'concat') {
          await fs.writeFile(plan.concatListPath, buildConcatListContent(plan.concatInputs));
        }
        const baseMs = doneMs;
        await this.ffmpeg.run(pass.args, {
          durationMs: pass.durationMs,
          timeoutMs: 300_000,
          onProgress: (pct) =>
            this.reportProgress(
              step,
              project,
              ((baseMs + (pass.durationMs * pct) / 100) / totalMs) * 100,
            ),
        });
        doneMs += pass.durationMs;
      }

      // 4) verificação do composto (vídeo + áudio, dimensões, duração ≈ falas + silêncios)
      const probe = await this.ffmpeg.probe(plan.output);
      const issue = composedOutputIssue(probe, {
        durationMs: plan.expectedDurationMs,
        width,
        height,
      });
      if (issue) throw new TerminalProviderError(`Composição inválida: ${issue}`, issue);

      // 5) publica em /final/v{n}/composed.mp4 (n = entregas + 1, mesma pasta do finalize)
      const version = await this.nextDeliveryVersion(project.id);
      const relDir = this.storage.finalRelDir(project.userId, project.id, version);
      const target = await this.storage.prepareStreamTarget(relDir, 'composed.mp4');
      await this.storage.copyFile(plan.output, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const fileSize = (await fs.stat(target.finalPath)).size;

      // snapshot persistido: assets/URLs em vez de caminhos temporários
      const snapshot: Record<string, unknown> = {
        ...input,
        backgroundArtAssetId: project.backgroundArtAssetId ?? null,
        backgroundArtPath: art?.fileUrl ?? null,
        clips: input.clips.map((clip, i) => ({
          sceneId: clip.sceneId,
          finalAssetId: measured[i].finalAssetId,
          path: measured[i].fileUrl,
          startS: clip.startS,
          endS: clip.endS,
        })),
        resolvedWindow,
        windowPx: plan.windowPx,
        graphVersion: MC_COMPOSE_GRAPH_VERSION,
      };

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'commercial_composed' as const,
          status: 'ready' as const,
          name: `Composição — ${project.title.slice(0, 60)} (v${version})`,
          origin: 'ai_generated' as const,
          fileUrl: target.url,
          mimeType: 'video/mp4',
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            version,
            format: input.format,
            aspectRatio: project.aspectRatio,
            graphVersion: MC_COMPOSE_GRAPH_VERSION,
            window: resolvedWindow ?? window,
            windowPx: plan.windowPx,
            artRect: plan.artRect,
            logoFace: input.logoFace,
            logoBox,
            backgroundColor,
            backgroundArtAssetId: project.backgroundArtAssetId ?? null,
            gapMs: MC_TALK_GAP_MS,
            endcard: !!input.endcard,
            timeline: {
              totalS: timeline.totalS,
              scenes: measured.map((clip, i) => ({
                sceneId: clip.sceneId,
                idx: scenes[i].idx,
                finalAssetId: clip.finalAssetId,
                startS: timeline.clips[i].startS,
                endS: timeline.clips[i].endS,
              })),
            },
          },
        });
        await manager.update(McStep, { id: step.id }, { inputSnapshot: snapshot });
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: 'ffmpeg',
          consumeOnSuccess: true, // tabela: 0 (composição determinística)
        });
      });
    } catch (err) {
      this.logger.error(`compose_ffmpeg ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'compose_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }
  }

  /** Dimensões da arte: as do asset; sem elas, lidas do arquivo (sharp). */
  private async artDimensions(
    file: string,
    width: number | null,
    height: number | null,
  ): Promise<{ width: number; height: number } | null> {
    if (width && height && width > 0 && height > 0) return { width, height };
    const meta = await sharp(file)
      .metadata()
      .catch(() => null);
    return meta?.width && meta?.height ? { width: meta.width, height: meta.height } : null;
  }

  /** Versão da entrega = finalizações entregues + 1 (compose e finalize da mesma entrega partilham a pasta). */
  private async nextDeliveryVersion(projectId: string): Promise<number> {
    const delivered = await this.dataSource.getRepository(McStep).count({
      where: { projectId, type: McStepType.FINALIZE, status: McStepStatus.SUCCEEDED },
    });
    return delivered + 1;
  }

  /** Progresso → notify pct no canal mc_events (throttle 1/s já vem do runner). */
  private async reportProgress(step: McStep, project: McProject, pct: number): Promise<void> {
    const bounded = Math.max(0, Math.min(100, Math.round(pct)));
    await this.dataSource
      .transaction((manager) =>
        this.pipeline.notifyStep(manager, project.userId, step, McStepStatus.RUNNING, {
          progressPct: bounded,
        }),
      )
      .catch(() => undefined);
  }
}
