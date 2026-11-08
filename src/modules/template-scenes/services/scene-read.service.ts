import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm';
import { SCENE_BUSY_STATUSES, SCENE_LIMITS } from '../domain/scene.types';
import { FaceKey } from '../domain/scene-faces';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { invalidBody, sceneNotFound } from '../scene.errors';
import { loadFaces, pickFace } from './scene-faces';
import { displayNumbersOf } from './scene-display-number';
import {
  SceneDetailView,
  SceneListItemView,
  SceneMessagesPageView,
  toCurrentVersionView,
  toFaceView,
  toMessageView,
  toSummaryView,
  toVersionView,
} from './scene-views';

/** Ordem das mensagens (mais novas primeiro): `createdAt`, o papel (o usuário antes do assistente na tela) e o `id`. */
const MESSAGE_ORDER = { createdAt: 'DESC', role: 'ASC', id: 'DESC' } as const;

/** Leituras da cena (detalhe, lista e mensagens antigas) como views; roda no `manager` da mutação quando recebe um. */
@Injectable()
export class SceneReadService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Detalhe da cena. `faceKey` escolhe de qual face vem a página de versões (padrão: face 0); `currentVersion` e
   * `zones` do topo são sempre os da face 0, e `faces` traz a versão atual de cada face.
   */
  async loadDetail(
    sceneId: string,
    versionsPage = 1,
    manager: EntityManager = this.dataSource.manager,
    faceKey?: FaceKey,
  ): Promise<SceneDetailView> {
    const scene = await manager.findOne(TemplateScene, { where: { id: sceneId } });
    if (!scene) throw sceneNotFound();
    const faces = await loadFaces(manager, sceneId);
    const pageFace = pickFace(faces, faceKey);
    const limit = SCENE_LIMITS.versionsPageSize;
    // O painel lista só as versões com imagem da face (o filtro entra na paginação); o número exibido vem da face inteira.
    const [pageVersions, totalVersions] = await manager.findAndCount(TemplateSceneVersion, {
      where: { sceneId, faceIndex: pageFace.index, status: 'ready', masterAssetId: Not(IsNull()) },
      order: { number: 'DESC' },
      skip: (versionsPage - 1) * limit,
      take: limit,
    });
    const currents = await this.currentVersions(manager, faces);
    const active = await manager.findOne(TemplateSceneVersion, {
      where: { sceneId, status: In([...SCENE_BUSY_STATUSES]) },
    });
    const messages = await manager.find(TemplateSceneMessage, {
      where: { sceneId },
      // Resposta sem job grava as duas mensagens na mesma transação, e o `now()` do Postgres é a hora de
      // início dela: `createdAt` empata. Em ordem DESC (antes do `reverse`), 'assistant' < 'user' põe o
      // assistente primeiro, e o `reverse` deixa o usuário antes do assistente (PV-21). O `id` fecha o empate
      // do mesmo papel, e é a mesma ordem que `loadMessages` usa para o cursor.
      order: MESSAGE_ORDER,
      take: SCENE_LIMITS.recentMessages,
    });
    const displayNumbers = await displayNumbersOf(manager, sceneId);

    const assets = await this.loadAssets(manager, [
      ...pageVersions,
      ...currents.values(),
      ...(active ? [active] : []),
    ]);
    const { layout } = scene;
    const currentView = (version: TemplateSceneVersion | undefined) =>
      version ? toCurrentVersionView(version, assets, displayNumbers, layout) : null;
    return {
      ...toSummaryView(scene),
      zones: faces[0].zones,
      currentVersion: currentView(currents.get(faces[0].index)),
      activeVersion: active ? toVersionView(active, assets, displayNumbers, layout) : null,
      faces: faces.map((face) => toFaceView(face, currentView(currents.get(face.index)))),
      messages: messages.reverse().map((message) => toMessageView(message, layout)),
      versions: {
        items: pageVersions.map((version) =>
          toVersionView(version, assets, displayNumbers, layout),
        ),
        total: totalVersions,
        page: versionsPage,
        limit,
        totalPages: Math.max(1, Math.ceil(totalVersions / limit)),
      },
    };
  }

  /** A versão atual de cada face (por índice da face); face sem versão fica de fora. */
  private async currentVersions(
    manager: EntityManager,
    faces: Array<{ index: number; currentVersionId: string | null }>,
  ): Promise<Map<number, TemplateSceneVersion>> {
    const ids = faces.map((face) => face.currentVersionId).filter(Boolean) as string[];
    if (ids.length === 0) return new Map();
    const found = await manager.findBy(TemplateSceneVersion, { id: In(ids) });
    const byId = new Map(found.map((version) => [version.id, version]));
    const result = new Map<number, TemplateSceneVersion>();
    for (const face of faces) {
      const version = face.currentVersionId ? byId.get(face.currentVersionId) : undefined;
      if (version) result.set(face.index, version);
    }
    return result;
  }

  /**
   * Mensagens anteriores a `before` (até `limit`), na ordem do detalhe, com `hasMore`. A ordem é a tupla
   * `(createdAt DESC, role ASC, id DESC)`, e o servidor resolve o cursor nela: `createdAt` empata dentro da mesma
   * transação, e uma página que cai entre duas mensagens do mesmo instante não repete nem perde nenhuma.
   * `before` que não é da cena: 400. Cena inexistente ou excluída: 404.
   */
  async loadMessages(
    sceneId: string,
    page: { before?: string; limit?: number },
  ): Promise<SceneMessagesPageView> {
    const manager = this.dataSource.manager;
    const scene = await manager.findOne(TemplateScene, { where: { id: sceneId } });
    if (!scene) throw sceneNotFound();
    const limit = page.limit ?? SCENE_LIMITS.recentMessages;
    const query = manager
      .getRepository(TemplateSceneMessage)
      .createQueryBuilder('m')
      .where('m.sceneId = :sceneId', { sceneId });
    if (page.before) {
      const cursor = await manager.findOne(TemplateSceneMessage, {
        where: { id: page.before, sceneId },
      });
      if (!cursor) throw invalidBody('O cursor "before" não é uma mensagem desta cena.');
      // A tupla é comparada no banco, a partir do id do cursor: `createdAt` tem microssegundos, e o `Date` do ORM só
      // tem milissegundos, o que tiraria da página a mensagem do mesmo instante real (R14).
      query.andWhere(
        `EXISTS (
          SELECT 1 FROM template_scene_messages c
          WHERE c.id = :cursorId AND (m."createdAt" < c."createdAt"
            OR (m."createdAt" = c."createdAt" AND (m.role > c.role OR (m.role = c.role AND m.id < c.id)))))`,
        { cursorId: cursor.id },
      );
    }
    const rows = await query
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.role', 'ASC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1)
      .getMany();
    return {
      items: rows
        .slice(0, limit)
        .reverse()
        .map((message) => toMessageView(message, scene.layout)),
      hasMore: rows.length > limit,
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
      layout: scene.layout,
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
