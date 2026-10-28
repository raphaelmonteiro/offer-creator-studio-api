import { Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McStepStatus } from '../domain/mc-state-machines';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McProject } from '../entities/mc-project.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { saveChunkAssets } from './mc-talk-chunk-assets';
import { McTalkChunkConformer } from './mc-talk-chunk-conform';
import type {
  ChunkBilling,
  ChunkIngestArgs,
  ChunkIngestHelpers,
} from './mc-talk-chunk-ingest.types';
import { McTalkChunkPublisher } from './mc-talk-chunk-publish';

export type { ChunkIngestArgs, ChunkIngestHelpers } from './mc-talk-chunk-ingest.types';

/**
 * Ingest do `talk` de um TRECHO (change video-fala-continua, D7/D8): conforma o clipe do motor ao áudio
 * do trecho e o fatia por fala NUM passe só, inspeciona o trecho inteiro (uma chamada), publica uma
 * fatia por cena (a líder leva custo e telemetria) e, no mesmo commit, deixa as cenas seguidoras
 * `ready` e conclui o step.
 */
export class McTalkChunkIngest {
  private readonly conformer: McTalkChunkConformer;
  private readonly publisher: McTalkChunkPublisher;

  constructor(
    private readonly dataSource: DataSource,
    ffmpeg: FfmpegRunner,
    storage: McStorageService,
    private readonly pipeline: McPipelineService,
    logger: Logger,
  ) {
    this.conformer = new McTalkChunkConformer(dataSource, ffmpeg, storage, logger);
    this.publisher = new McTalkChunkPublisher(ffmpeg, storage);
  }

  async run(args: ChunkIngestArgs, helpers: ChunkIngestHelpers): Promise<void> {
    const { step, project, chunk, tempDir } = args;
    const conformed = await this.conformer.conform(args);
    const resolution = await helpers.checkResolution(step, project, conformed.measured);
    const inspection = await helpers.inspect(step, project, {
      path: conformed.fullPath,
      durationMs: conformed.measured.durationMs ?? 0,
      tempDir,
      talk: true,
      speechWindows: conformed.speechWindows,
      // trecho que parte do último quadro do anterior: confere a identidade contra o tile (D7)
      identityReference: chunk.join != null,
    });
    const scenes = await this.chunkScenes(chunk);
    const published = await this.publisher.publishSlices(project, scenes, conformed);
    const chunkAsset = await this.publisher.publishFull(project, scenes[0], conformed);
    const joinFrame = await this.publisher.publishJoinFrame({
      project,
      scenes,
      conformed,
      chunk,
      tempDir,
    });
    const billing = helpers.billing(step, project, args.probe.durationMs, true);
    await this.dataSource.transaction(async (manager) => {
      const leaderAssetId = await saveChunkAssets(manager, {
        step,
        project,
        chunk,
        scenes,
        conformed,
        published,
        chunkAsset,
        joinFrame,
        resolution,
        inspection,
        billing,
      });
      await this.completeChunk(manager, {
        step,
        project,
        scenes,
        leaderAssetId,
        published,
        billing,
      });
    });
  }

  private async chunkScenes(chunk: ChunkSnapshot): Promise<McScene[]> {
    const rows = await this.dataSource
      .getRepository(McScene)
      .find({ where: { id: In(chunk.sceneRowIds) } });
    const ordered = chunk.sceneRowIds.map((id) => rows.find((r) => r.id === id));
    if (ordered.some((r) => !r)) {
      throw new TerminalProviderError('Cena do trecho não encontrada', 'missing_input_asset');
    }
    return ordered as McScene[];
  }

  /** Conclui: seguidoras `ready` com a fatia delas, depois o step (a líder fica `ready` e o scheduler avança). */
  private async completeChunk(
    manager: EntityManager,
    input: {
      step: McStep;
      project: McProject;
      scenes: McScene[];
      leaderAssetId: string;
      published: Array<{ assetId: string }>;
      billing: ChunkBilling;
    },
  ): Promise<void> {
    const { step, project, scenes, published } = input;
    for (const [i, scene] of scenes.entries()) {
      if (i === 0) continue;
      await this.pipeline.markChunkSceneReady(manager, project.userId, scene, published[i].assetId);
    }
    await this.pipeline.completeStepAndAdvance(manager, step, {
      from: McStepStatus.INGESTING,
      outputAssetId: input.leaderAssetId,
      providerCostUsd: input.billing.providerCostUsd,
      consumeOnSuccess: false, // consumo já aconteceu no submit (§6.7)
    });
  }
}
