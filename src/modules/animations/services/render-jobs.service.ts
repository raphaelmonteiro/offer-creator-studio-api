import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull } from 'typeorm';
import { RenderJob } from '../entities/render-job.entity';
import { AnimationAsset } from '../entities/animation-asset.entity';
import { RenderStatus } from '../domain/task-state-machine';
import { CreateRenderJobDto } from '../dto/create-render-job.dto';
import { AnimationQueueService, QUEUES } from './animation-queue.service';
import { ResourceGuardService } from './resource-guard.service';
import { TaskTransitionService } from './task-transition.service';

const MAX_VIDEO_LAYERS = 4;

@Injectable()
export class RenderJobsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
    private readonly resourceGuard: ResourceGuardService,
    private readonly transitions: TaskTransitionService,
  ) {}

  /**
   * Cria o render (TDD §6.5 camada 3): SEMPRE aceito e enfileirado — em modo
   * degradado a resposta inclui `degradedMode` + posição na fila, nunca 5xx.
   */
  async create(
    userId: string,
    dto: CreateRenderJobDto,
  ): Promise<{ job: RenderJob; degradedMode: boolean; queuePosition: number }> {
    await this.validateSpec(userId, dto);
    return this.dataSource.transaction(async (manager) => {
      // GIF não carrega áudio (TDD §6.1): descarta na entrada, com aviso via metadata
      const spec = { ...dto.spec } as Record<string, unknown>;
      let audioDropped = false;
      if (dto.spec.format === 'gif') {
        const layers = dto.spec.layers.filter((l) => l.type !== 'audio');
        audioDropped = layers.length !== dto.spec.layers.length;
        spec.layers = layers;
      }
      const job = manager.create(RenderJob, {
        userId,
        flyerId: dto.flyerId ?? null,
        status: RenderStatus.QUEUED,
        spec: { ...spec, ...(audioDropped && { audioDropped: true }) },
      });
      await manager.save(job);
      await this.queue.publish(QUEUES.RENDER_EXPORT, { renderId: job.id });
      const queuePosition = await manager.count(RenderJob, {
        where: { status: RenderStatus.QUEUED },
      });
      return { job, degradedMode: this.resourceGuard.isDegraded(), queuePosition };
    });
  }

  async findOne(userId: string, id: string): Promise<RenderJob> {
    const job = await this.dataSource.getRepository(RenderJob).findOneBy({ id });
    if (!job) throw new NotFoundException('Render não encontrado');
    if (job.userId !== userId) throw new ForbiddenException();
    return job;
  }

  async findOneWithDownload(
    userId: string,
    id: string,
  ): Promise<RenderJob & { downloadUrl: string | null }> {
    const job = await this.findOne(userId, id);
    let downloadUrl: string | null = null;
    if (job.status === RenderStatus.SUCCEEDED && job.outputAssetId) {
      const asset = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: job.outputAssetId });
      downloadUrl = asset?.fileUrl ?? null;
    }
    return { ...job, downloadUrl };
  }

  async cancel(userId: string, id: string): Promise<RenderJob> {
    const job = await this.findOne(userId, id);
    return this.dataSource.transaction(async (manager) => {
      const won =
        (await this.transitions.transitionRender(
          manager,
          job.id,
          RenderStatus.QUEUED,
          RenderStatus.CANCELED,
          { finishedAt: new Date() },
        )) ||
        (await this.transitions.transitionRender(
          manager,
          job.id,
          RenderStatus.COMPOSITING,
          RenderStatus.CANCELED,
          { finishedAt: new Date() },
        ));
      if (!won) throw new BadRequestException('Render não pode mais ser cancelado');
      return manager.findOneByOrFail(RenderJob, { id: job.id });
    });
  }

  /** Ownership + estado dos assets + limites de camadas (TDD §4.1). */
  private async validateSpec(userId: string, dto: CreateRenderJobDto): Promise<void> {
    const videoLayers = dto.spec.layers.filter((l) => l.type === 'video' || l.type === 'mascot');
    if (videoLayers.length > MAX_VIDEO_LAYERS) {
      throw new BadRequestException(`Máximo de ${MAX_VIDEO_LAYERS} camadas de vídeo por render`);
    }
    for (const layer of dto.spec.layers) {
      const hasAsset = Boolean(layer.assetId);
      const hasUrl = Boolean(layer.url);
      if (hasAsset === hasUrl) {
        throw new BadRequestException('Cada camada deve ter exatamente um de assetId ou url');
      }
    }
    const assetIds = dto.spec.layers.map((l) => l.assetId).filter(Boolean) as string[];
    if (assetIds.length > 0) {
      const assets = await this.dataSource.getRepository(AnimationAsset).find({
        where: { id: In(assetIds), deletedAt: IsNull() },
      });
      for (const id of assetIds) {
        const asset = assets.find((a) => a.id === id);
        if (!asset) throw new BadRequestException(`Asset ${id} não encontrado`);
        if (asset.userId !== userId)
          throw new ForbiddenException(`Asset ${id} não pertence ao usuário`);
        if (asset.status !== 'ready' && asset.status !== 'approved') {
          throw new BadRequestException(`Asset ${id} não está pronto (${asset.status})`);
        }
      }
    }
  }
}
