import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { SceneTemplateConfiguration } from '../domain/scene-template.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { Template } from '../../templates/entities/template.entity';
import { SceneFilesService } from '../services/scene-files.service';
import { SceneLockService } from '../services/scene-lock.service';
import { readVersionMaster } from '../services/scene-master';
import {
  configurationFor,
  copyLogos,
  ProjectedTemplate,
  ProjectionSource,
  projectFull,
} from '../services/scene-template-projection';
import { SceneTemplateFilesService } from '../services/scene-template-files.service';
import {
  CurrentScene,
  imageUrlsOf,
  loadLayerAssets,
  planFor,
  projectionSourceOf,
  readCurrentScene,
  SyncPlan,
} from './scene-template-sync-read';
import { isStale, writeSceneTemplate } from './scene-template-sync-write';

export interface TemplateSyncJob {
  sceneId: string;
}

/** Falhas na mesma `revision` depois das quais a varredura para de tentar (PV-15). */
export const MAX_SYNC_ATTEMPTS = 3;
const ERROR_MAX_LENGTH = 300;

/** O que fica em `metrics.templateSync` da versão atual quando a projeção falha. */
export interface TemplateSyncFailure {
  failedAt: string;
  error: string;
  attempts: number;
  sceneRevision: number;
}

/**
 * Job `template_scene.template_sync`: mantém o template `type = 'full'` da cena em dia com a versão atual (D-9,
 * D-10). Lê sem trava, projeta fora da transação (sem provedor, só `sharp`), confere sob a trava que a cena não
 * mudou e grava o template. Idempotente: repetir o job com a cena em dia só atualiza `sceneRevision` (PV-12, PV-13).
 */
@Injectable()
export class SceneTemplateSyncProcessor {
  private readonly logger = new Logger(SceneTemplateSyncProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly files: SceneFilesService,
    private readonly templateFiles: SceneTemplateFilesService,
  ) {}

  async process(job: TemplateSyncJob, _jobId?: string): Promise<void> {
    const current = await readCurrentScene(this.dataSource.manager, job.sceneId);
    if (!current) return;
    try {
      await this.sync(current);
    } catch (error) {
      await this.recordFailure(current, error);
      throw error;
    }
  }

  private async sync(current: CurrentScene): Promise<void> {
    const manager = this.dataSource.manager;
    const source = projectionSourceOf(current);
    const { scene, version } = current;
    const existing = scene.approvedTemplateId
      ? await manager.findOneBy(Template, { id: scene.approvedTemplateId })
      : null;
    const projected = await this.project(
      planFor(existing, source.keys),
      { current, source },
      existing,
    );
    const read = {
      versionId: version.id,
      revision: scene.revision,
      approvedTemplateId: scene.approvedTemplateId,
    };
    await this.locks
      .run(
        scene.id,
        async ({ manager: tx, scene: locked }) => {
          if (isStale(locked, read)) return;
          await writeSceneTemplate(tx, {
            scene: locked,
            versionId: version.id,
            name: source.name,
            projected,
          });
        },
        { includeDeleted: true },
      )
      .catch((error) => {
        // Cena apagada de vez (retenção): nada a gravar.
        if ((error as { response?: { code?: string } }).response?.code !== 'SCENE_NOT_FOUND') {
          throw error;
        }
      });
  }

  private async project(
    plan: SyncPlan,
    { current, source }: { current: CurrentScene; source: ProjectionSource },
    existing: Template | null,
  ): Promise<ProjectedTemplate> {
    const manager = this.dataSource.manager;
    if (plan === 'touch') {
      const config = (existing as Template).configuration as SceneTemplateConfiguration;
      return {
        configuration: {
          ...config,
          source: {
            ...config.source,
            versionId: source.versionId,
            sceneRevision: source.sceneRevision,
          },
        },
        thumbnailUrl: (existing as Template).thumbnailUrl as string,
      };
    }
    const logoAssets = await loadLayerAssets(manager, source, 'logo');
    const logos = await copyLogos(source, logoAssets, this.templateFiles);
    if (plan === 'layers') {
      const urls = imageUrlsOf(existing as Template);
      return {
        configuration: configurationFor(source, urls, logos),
        thumbnailUrl: urls.thumbnail,
      };
    }
    return projectFull(
      {
        source,
        master: await this.masterOf(manager, current),
        overlays: await this.overlaysOf(manager, source),
        logos,
      },
      this.templateFiles,
    );
  }

  private async masterOf(manager: EntityManager, current: CurrentScene): Promise<Buffer> {
    const master = await readVersionMaster(manager, this.files, current.version);
    if (!master) throw new Error('Master da versão ausente');
    return master;
  }

  private async overlaysOf(manager: EntityManager, source: ProjectionSource) {
    const assets = await loadLayerAssets(manager, source, 'generated');
    const byId = new Map<string, TemplateSceneAsset>(assets.map((asset) => [asset.id, asset]));
    const overlays = [];
    for (const element of source.elements) {
      const asset =
        element.kind === 'generated' && element.assetId ? byId.get(element.assetId) : null;
      if (asset) overlays.push({ element, buffer: await this.files.read(asset.url) });
    }
    return overlays;
  }

  /** Grava a falha na versão atual (uma por tentativa; ao somar `MAX_SYNC_ATTEMPTS` a varredura para) e no log. */
  private async recordFailure(current: CurrentScene, error: unknown): Promise<void> {
    const { scene, version } = current;
    const previous = version.metrics.templateSync as TemplateSyncFailure | undefined;
    const attempts = previous?.sceneRevision === scene.revision ? previous.attempts + 1 : 1;
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      ERROR_MAX_LENGTH,
    );
    const failure: TemplateSyncFailure = {
      failedAt: new Date().toISOString(),
      error: message,
      attempts,
      sceneRevision: scene.revision,
    };
    this.logger.warn(
      `Template da cena ${scene.id} não sincronizado (tentativa ${attempts} de ${MAX_SYNC_ATTEMPTS}): ${message}`,
    );
    await this.dataSource
      .query(
        `UPDATE template_scene_versions SET metrics = jsonb_set(metrics, '{templateSync}', $1::jsonb, true) WHERE id = $2`,
        [JSON.stringify(failure), version.id],
      )
      .catch((writeError: Error) =>
        this.logger.error(`Falha ao registrar templateSync: ${writeError.message}`),
      );
  }
}
