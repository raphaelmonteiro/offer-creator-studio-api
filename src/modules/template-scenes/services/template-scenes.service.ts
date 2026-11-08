import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Template } from '../../templates/entities/template.entity';
import { CreateSceneDto } from '../dto/create-scene.dto';
import { acceptsFrontBack, FaceKey } from '../domain/scene-faces';
import { findSceneFormat } from '../domain/scene-formats';
import { nativeSizeOfFormat, pixelsPerCm } from '../domain/scene-format-size';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { sceneFormatUnsupported, sceneLayoutUnsupported, sceneNotFound } from '../scene.errors';
import { publishSceneEvent } from './scene-events';
import { faceKeyOfVersion, newFaces } from './scene-faces';
import { bumpRevision, findBusyVersion, SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { SceneDetailView, SceneListItemView, SceneMessagesPageView } from './scene-views';

/** Criar, listar, abrir e excluir (lógico) a cena. */
@Injectable()
export class TemplateScenesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly reads: SceneReadService,
  ) {}

  /**
   * Valida o formato (lista de impressão, 1:3 a 3:1) e o layout (frente e verso só nos formatos em retrato, D-9) e
   * grava a cena com o tamanho nativo e as faces, na mesma transação.
   */
  async create(dto: CreateSceneDto, userId: string | null): Promise<SceneDetailView> {
    const format = findSceneFormat(dto.formatId);
    const size = format ? nativeSizeOfFormat(format) : null;
    if (!format || !size) throw sceneFormatUnsupported(dto.formatId);
    const layout = dto.layout ?? 'single';
    if (layout === 'front_back' && !acceptsFrontBack(format.id)) {
      throw sceneLayoutUnsupported(format.id, layout);
    }

    const sceneId = await this.dataSource.transaction(async (manager) => {
      const scene = await manager.save(TemplateScene, {
        name: dto.name,
        formatId: format.id,
        layout,
        artWidthCm: format.artWidthCm,
        artHeightCm: format.artHeightCm,
        widthPx: size.width,
        heightPx: size.height,
        pixelsPerCm: pixelsPerCm(size, format),
        createdByUserId: userId,
      });
      await manager.insert(TemplateSceneFace, newFaces(scene, format, layout));
      return scene.id;
    });
    return this.reads.loadDetail(sceneId);
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

  messages(
    sceneId: string,
    page: { before?: string; limit?: number },
  ): Promise<SceneMessagesPageView> {
    return this.reads.loadMessages(sceneId, page);
  }

  get(sceneId: string, versionsPage = 1, face?: FaceKey): Promise<SceneDetailView> {
    return this.reads.loadDetail(sceneId, versionsPage, undefined, face);
  }

  /**
   * Exclusão lógica (D-4). Com versão em curso, marca `cancelRequestedAt`; o worker para antes da
   * próxima etapa. Repetir dá 404 (a cena excluída não é mais encontrada). O template da cena sai na
   * mesma transação; os arquivos dele ficam, porque os encartes já criados apontam para eles (PV-14).
   */
  async remove(sceneId: string): Promise<void> {
    await this.locks.run(sceneId, async ({ manager, scene }) => {
      const busy = await findBusyVersion(manager, sceneId);
      if (busy && !busy.cancelRequestedAt) {
        busy.cancelRequestedAt = new Date();
        await manager.save(busy);
      }
      if (scene.approvedTemplateId) {
        await manager.delete(Template, { id: scene.approvedTemplateId });
        scene.approvedTemplateId = null;
      }
      const revision = await bumpRevision(manager, scene);
      await manager.softDelete(TemplateScene, { id: sceneId });
      if (busy) {
        await publishSceneEvent(manager, {
          sceneId,
          versionId: busy.id,
          faceKey: faceKeyOfVersion(scene, busy),
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
