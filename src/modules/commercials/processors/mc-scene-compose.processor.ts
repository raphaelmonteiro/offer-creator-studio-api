import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { buildPosterArgs } from '../domain/mc-assembly-graph';
import {
  buildSceneComposeArgs,
  composeDurationIssue,
  composedOutputIssue,
} from '../domain/mc-scene-compose-graph';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/**
 * Consumer do step `scene_compose` (fila mc.ffmpeg, gate ResourceGuard —
 * ADR-001 §3.1): vídeo de ação + TTS aprovado → clipe FINAL da cena
 * `action_voiceover`, com a locução completa e uma única trilha de voz.
 *
 * - Inputs vêm do SNAPSHOT do step (assets aprovados), com fallback nos
 *   atalhos da cena (vídeo desta produção).
 * - Locução maior que o clipe é ERRO TERMINAL (`audio_exceeds_clip`) — a
 *   aprovação já validou com a duração medida; aqui é a rede de segurança
 *   com o arquivo real. Nunca `-shortest` escondendo corte.
 * - O arquivo composto é verificado por probe (vídeo + áudio + duração) antes
 *   de virar asset; poster/thumb como os demais clipes.
 * - Custo de tabela 0 (composição determinística) — consumo no sucesso.
 */
@Injectable()
export class McSceneComposeProcessor {
  private readonly logger = new Logger(McSceneComposeProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.SCENE_COMPOSE);
    if (!step || !step.sceneId) return;
    const scene = await this.dataSource.getRepository(McScene).findOneBy({ id: step.sceneId });
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!scene || !project) return;

    const tempDir = await this.ffmpeg.createTempDir('mc-compose-');
    try {
      const snapshot = (step.inputSnapshot ?? {}) as {
        videoAssetId?: string | null;
        audioAssetId?: string | null;
        videoStepId?: string | null;
      };
      const videoAssetId =
        snapshot.videoAssetId ??
        (await this.videoFromStep(snapshot.videoStepId)) ??
        scene.videoAssetId;
      const audioAssetId = snapshot.audioAssetId ?? scene.audioAssetId;
      const video = await this.assetOrFail(videoAssetId, 'vídeo de ação');
      const audio = await this.assetOrFail(audioAssetId, 'locução');
      const videoPath = this.storage.absoluteFromUrl(video.fileUrl as string);
      const audioPath = this.storage.absoluteFromUrl(audio.fileUrl as string);
      if (!videoPath || !audioPath) {
        throw new TerminalProviderError('Asset fora do bucket de uploads', 'missing_input_asset');
      }
      const videoProbe = await this.ffmpeg.probe(videoPath);
      const audioProbe = await this.ffmpeg.probe(audioPath);
      if (!videoProbe.hasVideo)
        throw new TerminalProviderError('Clipe de ação sem vídeo', 'invalid_scene_clip');
      const videoMs = videoProbe.durationMs ?? scene.durationS * 1000;
      const issue = composeDurationIssue(videoMs, audioProbe.durationMs);
      if (issue) {
        throw new TerminalProviderError(
          `A locução (${(issue.audioMs / 1000).toFixed(1)}s) não cabe no clipe (${(issue.videoMs / 1000).toFixed(1)}s) — encurte a fala ou divida a cena`,
          issue.code,
        );
      }

      const output = path.join(tempDir, 'composed.mp4');
      await this.ffmpeg.run(
        buildSceneComposeArgs({ videoPath, audioPath, output, videoDurationS: videoMs / 1000 }),
        { durationMs: videoMs, timeoutMs: 120_000 },
      );
      const outProbe = await this.ffmpeg.probe(output);
      const outIssue = composedOutputIssue(outProbe, videoMs);
      if (outIssue) throw new TerminalProviderError(`Composição inválida: ${outIssue}`, outIssue);

      const posterPath = path.join(tempDir, 'poster.jpg');
      await this.ffmpeg.run(buildPosterArgs(output, posterPath), {
        durationMs: 1000,
        timeoutMs: 60_000,
      });
      const posterBuffer = await fs.readFile(posterPath);
      const thumbBuffer = await sharp(posterBuffer)
        .resize({ width: 320 })
        .jpeg({ quality: 80 })
        .toBuffer();

      const relDir = this.storage.sceneRelDir(
        project.userId,
        project.id,
        scene.idx,
        scene.generation,
      );
      const stamp = Date.now();
      const target = await this.storage.prepareStreamTarget(relDir, `composed-${stamp}.mp4`);
      await this.storage.copyFile(output, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const posterUrl = await this.storage.saveFile(
        relDir,
        `composed-${stamp}-poster.jpg`,
        posterBuffer,
      );
      const thumbUrl = await this.storage.saveFile(
        relDir,
        `composed-${stamp}-thumb.jpg`,
        thumbBuffer,
      );
      const fileSize = (await fs.stat(target.finalPath)).size;

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'scene_synced' as const,
          status: 'ready' as const,
          name: `Cena ${scene.idx + 1} (narrada) — ${project.title.slice(0, 40)}`,
          origin: 'ai_generated' as const,
          fileUrl: target.url,
          posterUrl,
          thumbUrl,
          mimeType: 'video/mp4',
          width: outProbe.width,
          height: outProbe.height,
          durationMs: outProbe.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            sceneId: scene.id,
            scriptSceneId: scene.scriptSceneId,
            generation: scene.generation,
            provider: 'ffmpeg',
            composedFrom: { videoAssetId: video.id, audioAssetId: audio.id },
            audioPolicy: 'replace_clip_audio',
            audioDurationMs: audioProbe.durationMs,
            // a legenda desta cena usa o alinhamento do áudio aprovado
            alignment: (audio.metadata as { alignment?: unknown } | null)?.alignment ?? null,
            attempt: step.attempt,
            projectRevision: step.projectRevision,
          },
        });
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: 'ffmpeg',
          consumeOnSuccess: true, // tabela: 0 até calibração (P5)
        });
      });
    } catch (err) {
      this.logger.error(`scene_compose ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'compose_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }
  }

  private async videoFromStep(stepId: string | null | undefined): Promise<string | null> {
    if (!stepId) return null;
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    return step?.outputAssetId ?? null;
  }

  private async assetOrFail(
    assetId: string | null | undefined,
    label: string,
  ): Promise<AnimationAsset> {
    if (!assetId)
      throw new TerminalProviderError(`Cena sem ${label} para compor`, 'missing_input_asset');
    const asset = await this.dataSource.getRepository(AnimationAsset).findOneBy({ id: assetId });
    if (!asset?.fileUrl)
      throw new TerminalProviderError(`Asset de ${label} sem arquivo`, 'missing_input_asset');
    return asset;
  }
}
