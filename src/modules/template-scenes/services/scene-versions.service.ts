import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { PatchElementsDto } from '../dto/patch-elements.dto';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  assetNotInScene,
  noCurrentVersion,
  versionNotFound,
  versionNotReady,
} from '../scene.errors';
import { publishSceneEvent } from './scene-events';
import { assertMasterOnDisk, restoreInto } from './scene-restore';
import {
  assertExpectedRevision,
  assertSceneIdle,
  bumpRevision,
  closeOpenManual,
  nextVersionNumber,
  SceneLockService,
} from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { pruneSceneAssets } from './scene-retention';
import { SceneDetailView } from './scene-views';

const ELEMENT_ASSET_ROLES = ['logo', 'element'];

/** Restaurar versão e editar camadas à mão (sem chamada ao modelo). */
@Injectable()
export class SceneVersionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly reads: SceneReadService,
  ) {}

  /**
   * Cria uma versão `restore` filha da restaurada, apontando para a mesma master e prévia, e a
   * torna atual. Só vale com a master em disco (`purgedAt` nulo, conferido sob o lock da cena).
   */
  async restore(
    sceneId: string,
    versionId: string,
    userId: string | null,
    expectedRevision?: number,
  ): Promise<SceneDetailView> {
    return this.locks.run(sceneId, async ({ manager, scene }) => {
      if (expectedRevision !== undefined) assertExpectedRevision(scene, expectedRevision);
      await assertSceneIdle(manager, sceneId);
      const source = await manager.findOne(TemplateSceneVersion, {
        where: { id: versionId, sceneId },
      });
      if (!source) throw versionNotFound();
      if (source.status !== 'ready') throw versionNotReady();
      await assertMasterOnDisk(manager, source);

      await closeOpenManual(manager, sceneId);
      const restored = await restoreInto(manager, scene, source, { userId });
      return this.finishReadyVersion(manager, scene, restored);
    });
  }

  /**
   * Atualiza a versão `manual` aberta ou cria uma (`ready`, apontando para a master da atual). Ela
   * fecha no próximo pedido ao chat, no `restore` ou na aprovação (estágio 5).
   */
  async patchElements(
    sceneId: string,
    dto: PatchElementsDto,
    userId: string | null,
  ): Promise<SceneDetailView> {
    return this.locks.run(sceneId, async ({ manager, scene }) => {
      assertExpectedRevision(scene, dto.expectedRevision);
      await assertSceneIdle(manager, sceneId);
      const current = scene.currentVersionId
        ? await manager.findOne(TemplateSceneVersion, { where: { id: scene.currentVersionId } })
        : null;
      if (!current) throw noCurrentVersion();
      const elements = dto.elements as SceneElement[];
      await this.assertElementAssetsInScene(manager, sceneId, elements);

      const open = await manager.findOne(TemplateSceneVersion, {
        where: { sceneId, isOpenManual: true },
      });
      const manual = open
        ? await manager.save(Object.assign(open, { elements }))
        : await manager.save(
            manager.create(TemplateSceneVersion, {
              sceneId,
              parentVersionId: current.id,
              number: await nextVersionNumber(manager, sceneId),
              operation: 'manual',
              status: 'ready',
              masterAssetId: current.masterAssetId,
              previewAssetId: current.previewAssetId,
              elements,
              isOpenManual: true,
              correlationId: randomUUID(),
              createdByUserId: userId,
            }),
          );
      return this.finishReadyVersion(manager, scene, manual);
    });
  }

  /** Elementos só referenciam assets de logo/elemento da própria cena e ainda em disco. */
  private async assertElementAssetsInScene(
    manager: EntityManager,
    sceneId: string,
    elements: SceneElement[],
  ): Promise<void> {
    const assetIds = [...new Set(elements.map((e) => e.assetId).filter(Boolean))] as string[];
    if (assetIds.length === 0) return;
    const found = await manager.findBy(TemplateSceneAsset, { sceneId });
    const valid = new Set(
      found
        .filter((a) => ELEMENT_ASSET_ROLES.includes(a.role) && !a.purgedAt)
        .map((asset) => asset.id),
    );
    const missing = assetIds.find((id) => !valid.has(id));
    if (missing) throw assetNotInScene(missing);
  }

  /** Torna a versão atual, sobe a `revision`, avisa quem está na cena e devolve a cena completa. */
  private async finishReadyVersion(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
  ): Promise<SceneDetailView> {
    scene.currentVersionId = version.id;
    await pruneSceneAssets(manager, scene);
    const revision = await bumpRevision(manager, scene);
    await publishSceneEvent(manager, {
      sceneId: scene.id,
      versionId: version.id,
      kind: 'version.ready',
      step: null,
      status: 'ready',
      cancelRequested: false,
      costUsd: version.providerCostUsd,
      revision,
    });
    return this.reads.loadDetail(scene.id, 1, manager);
  }
}
