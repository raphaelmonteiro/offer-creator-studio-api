import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { SCENE_BUSY_STATUSES } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { revisionConflict, sceneBusy, sceneNotFound } from '../scene.errors';

export interface SceneLockContext {
  manager: EntityManager;
  scene: TemplateScene;
}

/**
 * Toda mutação da cena roda numa transação que começa com `SELECT ... FOR UPDATE` na linha dela.
 * Sob esse lock acontecem a conferência de `expectedRevision`, a conferência de cena ocupada e a
 * alocação de `number` (`max + 1`). O worker usa o mesmo lock ao terminar uma versão.
 */
@Injectable()
export class SceneLockService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** `includeDeleted`: o worker precisa enxergar a cena excluída para cancelar a versão em curso. */
  async run<T>(
    sceneId: string,
    fn: (context: SceneLockContext) => Promise<T>,
    options: { includeDeleted?: boolean } = {},
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const query = manager
        .getRepository(TemplateScene)
        .createQueryBuilder('scene')
        .setLock('pessimistic_write')
        .where('scene.id = :sceneId', { sceneId });
      if (options.includeDeleted) query.withDeleted();
      const scene = await query.getOne();
      if (!scene) throw sceneNotFound();
      return fn({ manager, scene });
    });
  }
}

/** 409 `REVISION_CONFLICT` quando o cliente viu uma revisão diferente da atual. */
export function assertExpectedRevision(scene: TemplateScene, expectedRevision: number): void {
  if (scene.revision !== expectedRevision) throw revisionConflict(scene.revision);
}

/** Versão `queued`/`running` da cena (no máximo uma, garantido pelo índice `UQ_tsv_scene_busy`). */
export async function findBusyVersion(
  manager: EntityManager,
  sceneId: string,
): Promise<TemplateSceneVersion | null> {
  return manager
    .getRepository(TemplateSceneVersion)
    .createQueryBuilder('version')
    .where('version.sceneId = :sceneId', { sceneId })
    .andWhere('version.status IN (:...busy)', { busy: [...SCENE_BUSY_STATUSES] })
    .getOne();
}

/** 409 `SCENE_BUSY` quando há versão em curso. */
export async function assertSceneIdle(manager: EntityManager, sceneId: string): Promise<void> {
  const busy = await findBusyVersion(manager, sceneId);
  if (busy) throw sceneBusy(busy.id);
}

/** Incrementa `revision` (toda mutação) e devolve o valor novo. */
export async function bumpRevision(manager: EntityManager, scene: TemplateScene): Promise<number> {
  scene.revision += 1;
  await manager.save(TemplateScene, scene);
  return scene.revision;
}

/** Próximo `number` de versão da cena (chamar sob o lock). */
export async function nextVersionNumber(manager: EntityManager, sceneId: string): Promise<number> {
  const row = await manager
    .getRepository(TemplateSceneVersion)
    .createQueryBuilder('version')
    .select('COALESCE(MAX(version.number), 0)', 'max')
    .where('version.sceneId = :sceneId', { sceneId })
    .getRawOne<{ max: string }>();
  return Number(row?.max ?? 0) + 1;
}
