import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { SCENE_BUSY_STATUSES, SCENE_LIMITS } from '../domain/scene.types';
import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { sceneNotFound } from '../scene.errors';
import {
  SceneDetailView,
  SceneListItemView,
  toCurrentVersionView,
  toMessageView,
  toSummaryView,
  toVersionView,
} from './scene-views';

const EMPTY_ZONES = {
  header: { x: 0, y: 0, w: 1, h: 0 },
  body: { x: 0, y: 0, w: 1, h: 1 },
  footer: { x: 0, y: 1, w: 1, h: 0 },
};

/** Leituras da cena (detalhe e lista) como views; roda no `manager` da mutação quando recebe um. */
@Injectable()
export class SceneReadService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async loadDetail(
    sceneId: string,
    versionsPage = 1,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<SceneDetailView> {
    const scene = await manager.findOne(TemplateScene, { where: { id: sceneId } });
    if (!scene) throw sceneNotFound();
    const limit = SCENE_LIMITS.versionsPageSize;
    const [pageVersions, totalVersions] = await manager.findAndCount(TemplateSceneVersion, {
      where: { sceneId },
      order: { number: 'DESC' },
      skip: (versionsPage - 1) * limit,
      take: limit,
    });
    const current = scene.currentVersionId
      ? await manager.findOne(TemplateSceneVersion, { where: { id: scene.currentVersionId } })
      : null;
    const active = await manager.findOne(TemplateSceneVersion, {
      where: { sceneId, status: In([...SCENE_BUSY_STATUSES]) },
    });
    const messages = await manager.find(TemplateSceneMessage, {
      where: { sceneId },
      order: { createdAt: 'DESC' },
      take: SCENE_LIMITS.recentMessages,
    });

    const assets = await this.loadAssets(manager, [
      ...pageVersions,
      ...(current ? [current] : []),
      ...(active ? [active] : []),
    ]);
    const format = findSceneFormat(scene.formatId);
    return {
      ...toSummaryView(scene),
      zones: format ? computeSceneZones(format) : EMPTY_ZONES,
      currentVersion: current ? toCurrentVersionView(current, assets) : null,
      activeVersion: active ? toVersionView(active, assets) : null,
      messages: messages.reverse().map(toMessageView),
      versions: {
        items: pageVersions.map((version) => toVersionView(version, assets)),
        total: totalVersions,
        page: versionsPage,
        limit,
        totalPages: Math.max(1, Math.ceil(totalVersions / limit)),
      },
    };
  }

  /** Assets citados pelas versões (master, prévia e imagens de elementos), por id. */
  private async loadAssets(
    manager: EntityManager,
    versions: TemplateSceneVersion[],
  ): Promise<Map<string, TemplateSceneAsset>> {
    const ids = new Set<string>();
    for (const version of versions) {
      for (const id of [version.masterAssetId, version.previewAssetId]) if (id) ids.add(id);
      for (const element of version.elements) if (element.assetId) ids.add(element.assetId);
    }
    if (ids.size === 0) return new Map();
    const assets = await manager.findBy(TemplateSceneAsset, { id: In([...ids]) });
    return new Map(assets.map((asset) => [asset.id, asset]));
  }

  async list(page: number, limit: number): Promise<{ items: SceneListItemView[]; total: number }> {
    const [scenes, total] = await this.dataSource.manager.findAndCount(TemplateScene, {
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const [previews, authors] = await Promise.all([
      this.previewUrlsByVersion(scenes),
      this.authorNames(scenes),
    ]);
    const items = scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      formatId: scene.formatId,
      previewUrl: scene.currentVersionId ? (previews.get(scene.currentVersionId) ?? null) : null,
      updatedAt: scene.updatedAt.toISOString(),
      totalCostUsd: scene.totalCostUsd,
      createdByUserId: scene.createdByUserId,
      createdByName: scene.createdByUserId ? (authors.get(scene.createdByUserId) ?? null) : null,
    }));
    return { items, total };
  }

  /** URL da prévia da versão atual de cada cena; nula quando a prévia foi apagada. */
  private async previewUrlsByVersion(scenes: TemplateScene[]): Promise<Map<string, string>> {
    const versionIds = scenes.map((scene) => scene.currentVersionId).filter(Boolean) as string[];
    if (versionIds.length === 0) return new Map();
    const manager = this.dataSource.manager;
    const versions = await manager.findBy(TemplateSceneVersion, { id: In(versionIds) });
    const previewIds = versions.map((v) => v.previewAssetId).filter(Boolean) as string[];
    const assets = previewIds.length
      ? await manager.findBy(TemplateSceneAsset, { id: In(previewIds) })
      : [];
    const urlByAsset = new Map(assets.filter((a) => !a.purgedAt).map((a) => [a.id, a.url]));
    return new Map(
      versions
        .filter((v) => v.previewAssetId && urlByAsset.has(v.previewAssetId))
        .map((v) => [v.id, urlByAsset.get(v.previewAssetId as string) as string]),
    );
  }

  /** Nome do autor (`users.name`), lido por SQL: o módulo não importa a entidade de outro módulo. */
  private async authorNames(scenes: TemplateScene[]): Promise<Map<string, string>> {
    const userIds = [...new Set(scenes.map((s) => s.createdByUserId).filter(Boolean))] as string[];
    if (userIds.length === 0) return new Map();
    const rows: Array<{ id: string; name: string }> = await this.dataSource.query(
      `SELECT id::text AS id, name FROM users WHERE id::text = ANY($1::text[])`,
      [userIds],
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
