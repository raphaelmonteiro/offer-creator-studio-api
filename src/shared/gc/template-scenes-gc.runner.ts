import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { resolveUploadsDir } from '../../common/config/uploads-dir';
import {
  SceneGcAsset,
  SceneGcConfig,
  SceneGcSelection,
  SceneGcVersion,
  sceneGcConfigFromEnv,
  selectSceneAssetsToPurge,
} from './template-scenes-gc.rules';

/** O GC das cenas só toca neste prefixo. */
export const SCENE_UPLOADS_URL_PREFIX = '/uploads/template-scenes/';

export interface TemplateScenesGcSummary {
  /** Assets selecionados para apagar. */
  selected: number;
  /** Arquivos realmente removidos (0 na simulação). */
  deleted: number;
  dryRun: boolean;
  /** URLs apagadas (ou que seriam apagadas, na simulação). */
  files: string[];
}

interface SceneRow {
  deletedAt: Date | null;
}

/**
 * Varredura dos arquivos da cena (D-12, PV-5, achados 5 e 6). Lê as tabelas `template_scene_*` por
 * SQL cru, porque o `shared/` não importa módulos. Para cada cena com algo vencido:
 *  1. pega o lock da cena (`FOR UPDATE`, o mesmo do `restore`);
 *  2. recalcula o conjunto protegido;
 *  3. grava `purgedAt` nos assets a apagar e faz commit;
 *  4. só então remove os arquivos.
 * O `restore` confere `purgedAt` sob o mesmo lock: nunca aponta para arquivo apagado.
 */
@Injectable()
export class TemplateScenesGcRunner {
  private readonly logger = new Logger(TemplateScenesGcRunner.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  /** `dryRun` ausente = `TEMPLATE_SCENE_GC_DRY_RUN`, que só apaga com `false` explícito. */
  async run(
    options: { dryRun?: boolean; now?: Date; onlySceneIds?: string[] } = {},
  ): Promise<TemplateScenesGcSummary> {
    const dryRun = options.dryRun ?? process.env.TEMPLATE_SCENE_GC_DRY_RUN !== 'false';
    const now = options.now ?? new Date();
    const config = sceneGcConfigFromEnv();
    const summary: TemplateScenesGcSummary = { selected: 0, deleted: 0, dryRun, files: [] };

    const candidates = await this.candidateSceneIds(now, config);
    // `onlySceneIds` restringe a varredura (testes e operação pontual); sem ele, todas as cenas.
    const sceneIds = options.onlySceneIds
      ? candidates.filter((id) => options.onlySceneIds?.includes(id))
      : candidates;
    for (const sceneId of sceneIds) {
      try {
        const done = await this.collectScene(sceneId, { dryRun, now, config });
        summary.selected += done.selected;
        summary.deleted += done.deleted;
        summary.files.push(...done.files);
      } catch (error) {
        this.logger.error(`GC da cena ${sceneId} falhou: ${(error as Error).message}`);
      }
    }
    this.logger.log(`GC das cenas: ${JSON.stringify({ ...summary, files: summary.files.length })}`);
    return summary;
  }

  private async candidateSceneIds(now: Date, config: SceneGcConfig): Promise<string[]> {
    const intermediateCutoff = new Date(now.getTime() - config.intermediateTtlMs);
    const deletedCutoff = new Date(now.getTime() - config.deletedRetentionMs);
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `SELECT DISTINCT a."sceneId"::text AS id
         FROM template_scene_assets a
         JOIN template_scenes s ON s.id = a."sceneId"
        WHERE a."purgedAt" IS NULL
          AND ((a."expiresAt" IS NOT NULL AND a."expiresAt" <= $1)
            OR (a.role IN ('raw_output', 'mask', 'crop') AND a."createdAt" <= $2)
            OR (s."deletedAt" IS NOT NULL AND s."deletedAt" <= $3))`,
      [now, intermediateCutoff, deletedCutoff],
    );
    return rows.map((row) => row.id);
  }

  private async collectScene(
    sceneId: string,
    run: { dryRun: boolean; now: Date; config: SceneGcConfig },
  ): Promise<TemplateScenesGcSummary> {
    const { dryRun, now, config } = run;
    const selection = await this.dataSource.transaction(async (manager) => {
      const scene = await this.lockScene(manager, sceneId);
      if (!scene) return null;
      const [versions, assets] = await Promise.all([
        this.loadVersions(manager, sceneId),
        this.loadAssets(manager, sceneId),
      ]);
      const chosen = selectSceneAssetsToPurge({
        assets,
        versions,
        sceneDeletedAt: scene.deletedAt,
        now,
        config,
      });
      if (!dryRun) await this.markPurged(manager, chosen, now);
      return chosen;
    });
    if (!selection) return { selected: 0, deleted: 0, dryRun, files: [] };

    const files = selection.purge.map((asset) => asset.url);
    let deleted = 0;
    if (!dryRun) {
      deleted = await this.removeFiles(files);
      if (selection.wholeScene) await this.removeSceneFolder(sceneId);
    }
    for (const asset of selection.purge) {
      this.logger.log(
        JSON.stringify({
          gc: 'template-scenes',
          action: dryRun ? 'would_delete' : 'deleted',
          sceneId,
          assetId: asset.id,
          role: asset.role,
          file: asset.url,
        }),
      );
    }
    return { selected: selection.purge.length, deleted, dryRun, files };
  }

  private async lockScene(manager: EntityManager, sceneId: string): Promise<SceneRow | null> {
    const rows: SceneRow[] = await manager.query(
      `SELECT "deletedAt" FROM template_scenes WHERE id = $1 FOR UPDATE`,
      [sceneId],
    );
    return rows[0] ?? null;
  }

  private loadVersions(manager: EntityManager, sceneId: string): Promise<SceneGcVersion[]> {
    return manager.query(
      `SELECT id::text AS id, number, status, "masterAssetId"::text AS "masterAssetId",
              "previewAssetId"::text AS "previewAssetId", "approvedAt"
         FROM template_scene_versions WHERE "sceneId" = $1`,
      [sceneId],
    );
  }

  private loadAssets(manager: EntityManager, sceneId: string): Promise<SceneGcAsset[]> {
    return manager.query(
      `SELECT id::text AS id, "versionId"::text AS "versionId", role, url, "createdAt",
              "expiresAt", "purgedAt"
         FROM template_scene_assets
        WHERE "sceneId" = $1 AND "purgedAt" IS NULL AND url LIKE $2`,
      [sceneId, `${SCENE_UPLOADS_URL_PREFIX}%`],
    );
  }

  /** `purgedAt` ANTES de apagar o arquivo; protegidos que ainda tinham `expiresAt` ficam sem a marca. */
  private async markPurged(
    manager: EntityManager,
    selection: SceneGcSelection,
    now: Date,
  ): Promise<void> {
    if (selection.purge.length > 0) {
      await manager.query(
        `UPDATE template_scene_assets SET "purgedAt" = $2 WHERE id::text = ANY($1::text[])`,
        [selection.purge.map((asset) => asset.id), now],
      );
    }
    if (selection.clearExpiry.length > 0) {
      await manager.query(
        `UPDATE template_scene_assets SET "expiresAt" = NULL WHERE id::text = ANY($1::text[])`,
        [selection.clearExpiry],
      );
    }
  }

  private async removeFiles(urls: string[]): Promise<number> {
    let deleted = 0;
    for (const url of urls) {
      const absolute = this.resolveUnderScenes(url);
      if (!absolute) {
        this.logger.warn(`GC das cenas ignorou caminho fora de uploads/template-scenes: ${url}`);
        continue;
      }
      try {
        await fs.unlink(absolute);
        deleted += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(`GC das cenas não conseguiu apagar ${url}: ${(error as Error).message}`);
        }
      }
    }
    return deleted;
  }

  private async removeSceneFolder(sceneId: string): Promise<void> {
    const folder = this.resolveUnderScenes(`${SCENE_UPLOADS_URL_PREFIX}${sceneId}/x`);
    if (folder) await fs.rm(path.dirname(folder), { recursive: true, force: true });
  }

  /** Caminho absoluto da URL, só se estiver sob `uploads/template-scenes/`. */
  private resolveUnderScenes(url: string): string | null {
    if (!url.startsWith(SCENE_UPLOADS_URL_PREFIX)) return null;
    const uploadsDir = resolveUploadsDir(this.config.get<string>('UPLOAD_DEST'));
    const absolute = path.resolve(uploadsDir, url.replace(/^\/uploads\//, ''));
    const root = path.join(uploadsDir, 'template-scenes') + path.sep;
    return absolute.startsWith(root) ? absolute : null;
  }
}
