import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ElevenLabsMusicProvider,
  MUSIC_UNAVAILABLE_CODE,
} from '../../../shared/providers/elevenlabs-music.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import {
  assemblyDimensions,
  buildConcatArgs,
  buildConcatListContent,
  buildEndcardArgs,
  buildFinalizeArgs,
  buildMockMusicArgs,
  buildNormalizeArgs,
  buildPosterArgs,
  buildSealCues,
  ENDCARD_DURATION_S,
  SceneWindow,
} from '../domain/mc-assembly-graph';
import { buildCaptionCues, ElevenLabsAlignment, TextCue } from '../domain/mc-captions';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType, resolveProjectOptions, sealProducts } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/** Pesos das fases no progresso (normalização domina o tempo de parede). */
const PROGRESS_WEIGHTS = { normalize: 0.7, concat: 0.1, finalize: 0.2 } as const;

/** Prompt FIXO da trilha (entra no hash do cache — mudar aqui invalida o cache). */
export const MC_MUSIC_PROMPT = 'trilha instrumental animada de varejo, sem vocais';

/** Folga da trilha sobre a duração do vídeo, e passo do bucket do cache (segundos). */
const MUSIC_EXTRA_S = 5;
const MUSIC_BUCKET_S = 5;

/**
 * Consumer da fila mc.ffmpeg (conc. 1, gate ResourceGuard — plano §6.4):
 * montagem final multi-cena (plano §5.1 etapa 6).
 *
 * Pipeline:
 * 1. normaliza cada clipe de cena no formato do PROJETO (9:16 720x1280 ·
 *    1:1 960x960 · 16:9 1280x720), h264 yuv420p 30fps, silêncio nos mudos;
 * 2. cartela final de 2s (quando `script.endcard`) com os mesmos parâmetros;
 * 3. concat demuxer;
 * 4. passe final: SELOS por produto (1 por cena, rotativo, na 2ª metade da
 *    cena), LEGENDAS queimadas dos timestamps do TTS, TRILHA instrumental com
 *    ducking sob a fala e loudnorm -14 LUFS;
 * 5. poster + thumb → asset `commercial_final` → projeto assembling→succeeded
 *    (+ e-mail de conclusão, não bloqueante).
 *
 * DEGRADAÇÃO da trilha (contrato v1-B1): erro TERMINAL do provider de música
 * (`music_unavailable` — conta sem Eleven Music, 401/403/422) NÃO derruba o
 * projeto: grava o evento `music_skipped` e a montagem segue sem trilha.
 *
 * Grafo de argumentos em domain/mc-assembly-graph.ts (puro, testado);
 * execução via FfmpegRunner (sandbox/timeout); progresso → notify pct no
 * canal mc_events.
 */
@Injectable()
export class McAssemblyProcessor {
  private readonly logger = new Logger(McAssemblyProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly music: ElevenLabsMusicProvider,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  private provider(): string {
    return process.env.MC_PIPELINE_PROVIDER || 'mock';
  }

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.ASSEMBLY);
    if (!step) return;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!project) return;

    // Cenas vivas da composição corrente, na ordem de montagem.
    const scenes = (
      await this.dataSource.getRepository(McScene).find({
        where: { projectId: project.id },
        order: { idx: 'ASC' },
      })
    ).filter((s) => s.status !== McSceneStatus.CANCELED);

    // Re-roll/cancel no meio do caminho: composição mudou — este assembly
    // morre em silêncio (o fluxo de edição cria outro step pendente).
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
          {
            finishedAt: new Date(),
            errorCode: 'composition_changed',
          },
        ),
      );
      return;
    }

    const options = resolveProjectOptions(project.options);
    const { width, height } = assemblyDimensions(project.aspectRatio);
    const tempDir = await this.ffmpeg.createTempDir('mc-assembly-');
    let delivered = false;
    try {
      const assets = await this.dataSource.getRepository(AnimationAsset).find({
        where: { id: In(scenes.map((s) => s.finalAssetId as string)) },
      });
      const clips: Array<{ path: string; durationMs: number }> = [];
      for (const scene of scenes) {
        const asset = assets.find((a) => a.id === scene.finalAssetId);
        const absolute = asset?.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null;
        if (!absolute) {
          throw new TerminalProviderError(
            `Asset final da cena ${scene.idx} ausente no disco`,
            'scene_asset_missing',
          );
        }
        clips.push({ path: absolute, durationMs: asset?.durationMs ?? scene.durationS * 1000 });
      }
      const totalMs = clips.reduce((sum, c) => sum + c.durationMs, 0);

      // 1) normalização por clipe (áudio sintético nos mudos), no formato do projeto
      const normalized: string[] = [];
      const windows: SceneWindow[] = [];
      let doneMs = 0;
      for (const [i, clip] of clips.entries()) {
        const probe = await this.ffmpeg.probe(clip.path);
        if (!probe.hasVideo) {
          throw new TerminalProviderError(`Clipe da cena ${i} sem vídeo`, 'invalid_scene_clip');
        }
        const output = path.join(tempDir, `norm-${i}.mp4`);
        const durationMs = probe.durationMs ?? clip.durationMs;
        const baseMs = doneMs;
        await this.ffmpeg.run(
          buildNormalizeArgs({
            input: clip.path,
            output,
            hasAudio: probe.hasAudio,
            durationS: Math.max(1, Math.round(durationMs / 1000)),
            width,
            height,
          }),
          {
            durationMs,
            timeoutMs: 120_000,
            onProgress: (pct) =>
              this.reportProgress(
                step,
                project,
                ((baseMs + (durationMs * pct) / 100) / totalMs) * PROGRESS_WEIGHTS.normalize * 100,
              ),
          },
        );
        // Janela da cena no vídeo final: base dos selos e do offset das legendas.
        windows.push({
          idx: scenes[i].idx,
          startS: doneMs / 1000,
          endS: (doneMs + durationMs) / 1000,
        });
        doneMs += durationMs;
        normalized.push(output);
      }

      // 2) cartela final determinística (2s) quando o roteiro tem endcard
      const endcard = project.script?.endcard ?? null;
      const hasEndcard = !!endcard?.storeName?.trim();
      if (hasEndcard && endcard) {
        const endcardPath = path.join(tempDir, 'endcard.mp4');
        await this.ffmpeg.run(
          buildEndcardArgs({
            output: endcardPath,
            storeName: endcard.storeName,
            width,
            height,
          }),
          { durationMs: ENDCARD_DURATION_S * 1000, timeoutMs: 60_000 },
        );
        normalized.push(endcardPath);
      }

      // 3) concat (cópia — tudo uniforme)
      const listPath = path.join(tempDir, 'concat.txt');
      await fs.writeFile(listPath, buildConcatListContent(normalized));
      const concatPath = path.join(tempDir, 'concat.mp4');
      const concatDurationMs = totalMs + (hasEndcard ? ENDCARD_DURATION_S * 1000 : 0);
      await this.ffmpeg.run(buildConcatArgs(listPath, concatPath), {
        durationMs: concatDurationMs,
        timeoutMs: 120_000,
        onProgress: (pct) =>
          this.reportProgress(
            step,
            project,
            (PROGRESS_WEIGHTS.normalize + (PROGRESS_WEIGHTS.concat * pct) / 100) * 100,
          ),
      });

      // 4) camadas determinísticas + trilha + loudness
      const sealCues = buildSealCues(windows, sealProducts(project.script?.seal));
      const captionCues = options.captionsEnabled ? await this.buildCaptions(scenes, windows) : [];
      const musicPath = options.musicEnabled
        ? await this.resolveSoundtrack(project, concatDurationMs / 1000, tempDir)
        : null;

      const finalTmp = path.join(tempDir, 'final.mp4');
      await this.ffmpeg.run(
        buildFinalizeArgs({
          input: concatPath,
          output: finalTmp,
          width,
          height,
          sealText: project.script?.seal?.text ?? null,
          sealCues,
          captionCues,
          musicPath,
        }),
        {
          durationMs: concatDurationMs,
          timeoutMs: 300_000,
          onProgress: (pct) =>
            this.reportProgress(
              step,
              project,
              (PROGRESS_WEIGHTS.normalize +
                PROGRESS_WEIGHTS.concat +
                (PROGRESS_WEIGHTS.finalize * pct) / 100) *
                100,
            ),
        },
      );

      // poster + thumb do final
      const posterPath = path.join(tempDir, 'poster.jpg');
      await this.ffmpeg.run(buildPosterArgs(finalTmp, posterPath), {
        durationMs: 1000,
        timeoutMs: 60_000,
      });
      const posterBuffer = await fs.readFile(posterPath);
      const thumbBuffer = await sharp(posterBuffer)
        .resize({ width: 320 })
        .jpeg({ quality: 80 })
        .toBuffer();
      const probeFinal = await this.ffmpeg.probe(finalTmp);

      // publica em /final/v{n}/ (n = montagens entregues + 1, plano §6.6)
      const priorFinals = await this.dataSource.getRepository(McStep).count({
        where: { projectId: project.id, type: McStepType.ASSEMBLY, status: McStepStatus.SUCCEEDED },
      });
      const version = priorFinals + 1;
      const relDir = this.storage.finalRelDir(project.userId, project.id, version);
      const target = await this.storage.prepareStreamTarget(relDir, 'final.mp4');
      await fs.copyFile(finalTmp, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const posterUrl = await this.storage.saveFile(relDir, 'poster.jpg', posterBuffer);
      const thumbUrl = await this.storage.saveFile(relDir, 'thumb.jpg', thumbBuffer);
      const fileSize = (await fs.stat(target.finalPath)).size;

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'commercial_final' as const,
          status: 'ready' as const,
          name: `Comercial — ${project.title.slice(0, 60)} (v${version})`,
          origin: 'ai_generated' as const,
          fileUrl: target.url,
          posterUrl,
          thumbUrl,
          mimeType: 'video/mp4',
          width: probeFinal.width,
          height: probeFinal.height,
          durationMs: probeFinal.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            version,
            sceneCount: scenes.length,
            sealed: sealCues.length > 0 || !!project.script?.seal?.text,
            captions: captionCues.length,
            music: !!musicPath,
            endcard: hasEndcard,
            aspectRatio: project.aspectRatio,
          },
        });
        const completed = await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: 'ffmpeg',
          consumeOnSuccess: true, // custo de tabela do assembly: 0 (plano §8)
        });
        if (completed) {
          delivered = await this.pipeline.succeedProject(manager, project.id, asset.id);
        }
      });
    } catch (err) {
      this.logger.error(`Assembly ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'assembly_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }

    // E-mail FORA da transação (SMTP lento não segura lock de banco) e sempre
    // não bloqueante — o método engole qualquer erro (plano §7.2: "pode sair,
    // avisamos por e-mail").
    if (delivered) {
      await this.pipeline.sendCompletionEmail(project.id, McProjectStatus.SUCCEEDED);
    }
  }

  // ──────────────────────────── legendas/trilha ────────────────────────────

  /**
   * Legendas de todas as cenas faladas: alinhamento por caractere gravado no
   * asset de áudio pelo McTtsProcessor → linhas de ≤38 chars deslocadas para a
   * janela da cena no vídeo final. Cena sem áudio/alinhamento simplesmente não
   * gera legenda (degradação silenciosa — o comercial sai igual).
   */
  private async buildCaptions(scenes: McScene[], windows: SceneWindow[]): Promise<TextCue[]> {
    const audioIds = scenes
      .map((s) => s.audioAssetId)
      .filter((id): id is string => typeof id === 'string');
    if (audioIds.length === 0) return [];
    const assets = await this.dataSource
      .getRepository(AnimationAsset)
      .find({ where: { id: In(audioIds) } });
    const cues: TextCue[] = [];
    for (const [position, scene] of scenes.entries()) {
      if (!scene.audioAssetId) continue;
      const asset = assets.find((a) => a.id === scene.audioAssetId);
      const alignment = asset?.metadata?.alignment as ElevenLabsAlignment | undefined;
      if (!alignment) continue;
      const window = windows[position];
      if (!window) continue;
      cues.push(
        ...buildCaptionCues(alignment, {
          offsetS: window.startS,
          clipDurationS: window.endS - window.startS,
        }),
      );
    }
    return cues;
  }

  /**
   * Trilha do projeto: 1 faixa por projeto, com CACHE POR HASH (prompt fixo +
   * duração em bucket de 5s) no bucket de uploads — o mesmo comprimento sai de
   * graça no próximo projeto/re-montagem. `music_unavailable` (conta sem
   * Eleven Music) degrada: evento `music_skipped` e retorno null.
   */
  private async resolveSoundtrack(
    project: McProject,
    videoDurationS: number,
    tempDir: string,
  ): Promise<string | null> {
    const lengthS = Math.ceil((videoDurationS + MUSIC_EXTRA_S) / MUSIC_BUCKET_S) * MUSIC_BUCKET_S;
    const provider = this.provider();
    const hash = createHash('sha256')
      .update(`${provider}|${MC_MUSIC_PROMPT}|${lengthS}`)
      .digest('hex')
      .slice(0, 32);
    const relDir = this.storage.musicCacheRelDir();
    const cachedPath = path.join(this.storage.uploadsDir(), relDir, `${hash}.mp3`);
    const cached = await fs
      .stat(cachedPath)
      .then(() => true)
      .catch(() => false);
    if (cached) return cachedPath;

    try {
      if (provider === 'mock') {
        const tmp = path.join(tempDir, 'music.mp3');
        await this.ffmpeg.run(buildMockMusicArgs(tmp, lengthS), {
          durationMs: lengthS * 1000,
          timeoutMs: 60_000,
        });
        await this.storage.saveFile(relDir, `${hash}.mp3`, await fs.readFile(tmp));
        return cachedPath;
      }
      const audio = await this.music.compose({
        prompt: MC_MUSIC_PROMPT,
        lengthMs: lengthS * 1000,
      });
      await this.storage.saveFile(relDir, `${hash}.mp3`, audio);
      return cachedPath;
    } catch (err) {
      // Só a indisponibilidade do Music degrada; qualquer outro erro sobe e o
      // failStep decide (é falha de verdade da montagem).
      const code = err instanceof TerminalProviderError ? err.code : null;
      if (code !== MUSIC_UNAVAILABLE_CODE) throw err;
      this.logger.warn(
        `Trilha indisponível no projeto ${project.id} (${(err as Error).message}) — montagem segue sem música.`,
      );
      await this.dataSource
        .transaction((manager: EntityManager) =>
          this.commercials.appendEvent(manager, {
            userId: project.userId,
            refKind: 'project',
            refId: project.id,
            kind: 'music_skipped',
            detail: { reason: code, lengthS },
          }),
        )
        .catch(() => undefined);
      return null;
    }
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
