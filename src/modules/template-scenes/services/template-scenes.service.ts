import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CreateSceneDto } from '../dto/create-scene.dto';
import { findSceneFormat } from '../domain/scene-formats';
import { nativeSizeOfFormat, pixelsPerCm } from '../domain/scene-format-size';
import { TemplateScene } from '../entities/template-scene.entity';
import { sceneFormatUnsupported, sceneNotFound } from '../scene.errors';
import { publishSceneEvent } from './scene-events';
import { bumpRevision, findBusyVersion, SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { SceneDetailView, SceneListItemView } from './scene-views';

/** Criar, listar, abrir e excluir (lógico) a cena. */
@Injectable()
export class TemplateScenesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly reads: SceneReadService,
  ) {}

  /** Valida o formato (lista de impressão, 1:3 a 3:1) e grava a cena com o tamanho nativo. */
  async create(dto: CreateSceneDto, userId: string | null): Promise<SceneDetailView> {
    const format = findSceneFormat(dto.formatId);
    const size = format ? nativeSizeOfFormat(format) : null;
    if (!format || !size) throw sceneFormatUnsupported(dto.formatId);

    const scene = await this.dataSource.manager.save(TemplateScene, {
      name: dto.name,
      formatId: format.id,
      artWidthCm: format.artWidthCm,
      artHeightCm: format.artHeightCm,
      widthPx: size.width,
      heightPx: size.height,
      pixelsPerCm: pixelsPerCm(size, format),
      createdByUserId: userId,
    });
    return this.reads.loadDetail(scene.id);
  }

  async list(page = 1, limit = 20): Promise<{ data: SceneListItemView[]; pagination: PageInfo }> {
    const { items, total } = await this.reads.list(page, limit);
    return {
      data: items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** 404 se a cena não existe ou foi excluída (antes de abrir o stream de eventos). */
  async assertExists(sceneId: string): Promise<void> {
    const found = await this.dataSource.manager.exists(TemplateScene, { where: { id: sceneId } });
    if (!found) throw sceneNotFound();
  }

  get(sceneId: string, versionsPage = 1): Promise<SceneDetailView> {
    return this.reads.loadDetail(sceneId, versionsPage);
  }

  /**
   * Exclusão lógica (D-4). Com versão em curso, marca `cancelRequestedAt`; o worker para antes da
   * próxima etapa. Repetir dá 404 (a cena excluída não é mais encontrada).
   */
  async remove(sceneId: string): Promise<void> {
    await this.locks.run(sceneId, async ({ manager, scene }) => {
      const busy = await findBusyVersion(manager, sceneId);
      if (busy && !busy.cancelRequestedAt) {
        busy.cancelRequestedAt = new Date();
        await manager.save(busy);
      }
      const revision = await bumpRevision(manager, scene);
      await manager.softDelete(TemplateScene, { id: sceneId });
      if (busy) {
        await publishSceneEvent(manager, {
          sceneId,
          versionId: busy.id,
          kind: 'version.step',
          step: busy.step,
          status: busy.status,
          cancelRequested: true,
          costUsd: busy.providerCostUsd,
          revision,
        });
      }
    });
  }
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
