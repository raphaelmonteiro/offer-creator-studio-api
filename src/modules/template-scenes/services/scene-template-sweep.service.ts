import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { MAX_SYNC_ATTEMPTS } from '../processors/scene-template-sync.processor';
import { TemplateScene } from '../entities/template-scene.entity';
import { TEMPLATE_SYNC_RETRY_LIMIT } from './scene-events';
import { loadFaces, setFaceTemplate } from './scene-faces';

/** Varredura a cada minuto, como a do reconciliador. */
export const TEMPLATE_SWEEP_INTERVAL_MS = 60 * 1000;
/** Cenas enfileiradas por passada: o backfill das cenas antigas anda 20 por minuto. */
export const TEMPLATE_SWEEP_BATCH = 20;

/**
 * Cenas com alguma face de versão atual `ready` e sem template, ou com o template atrás da `revision` da cena, e que
 * ainda não somaram `MAX_SYNC_ATTEMPTS` falhas na `revision` atual (PV-15, PV-16). A comparação com a falha usa a mesma
 * `sceneRevision` gravada pelo job: cena que mudou volta a ser tentada. O template da face 0 também vale pelo
 * `approvedTemplateId` da cena (espelho), como no job.
 */
const STALE_SCENES_SQL = `
  SELECT s.id
    FROM template_scenes s
   WHERE s."deletedAt" IS NULL
     AND EXISTS (
       SELECT 1
         FROM template_scene_faces f
         JOIN template_scene_versions v ON v.id = f."currentVersionId" AND v.status = 'ready'
              AND v."masterAssetId" IS NOT NULL
         LEFT JOIN templates t
                ON t.id = COALESCE(f."templateId", CASE WHEN f."index" = 0 THEN s."approvedTemplateId" END)
        WHERE f."sceneId" = s.id
          AND (t.id IS NULL
               OR COALESCE((t.configuration->'source'->>'sceneRevision')::int, -1) < s.revision)
          AND NOT (COALESCE((v.metrics->'templateSync'->>'attempts')::int, 0) >= $1
                   AND COALESCE((v.metrics->'templateSync'->>'sceneRevision')::int, -1) = s.revision))
   ORDER BY s."createdAt" ASC
   LIMIT $2`;

/**
 * Template de cena excluída que ainda existe (exclusão que escapou): o de qualquer face e o que a cena apontava. Só
 * apaga o que o marcador liga àquela cena; os ponteiros das faces e o espelho da cena são zerados depois, por `setFaceTemplate`.
 */
const ORPHAN_TEMPLATES_SQL = `
  WITH gone AS (
    DELETE FROM templates t USING template_scenes s
     WHERE s."deletedAt" IS NOT NULL
       AND (t.id = s."approvedTemplateId"
            OR EXISTS (SELECT 1 FROM template_scene_faces f
                        WHERE f."sceneId" = s.id AND f."templateId" = t.id))
       AND t.configuration->'source'->>'kind' = 'template-scene'
       AND t.configuration->'source'->>'sceneId' = s.id::text
    RETURNING t.id AS "templateId", s.id AS "sceneId"
  )
  SELECT "templateId", "sceneId" FROM gone`;

/**
 * Varredura do worker (no boot e a cada minuto, só com a flag da cena ligada): enfileira o job de sincronização das
 * cenas sem template ou atrás da `revision` (cobre job perdido, falha e o backfill das cenas antigas, sem script) e
 * apaga o template de cena excluída que escapou da exclusão.
 */
@Injectable()
export class SceneTemplateSweepService implements OnModuleDestroy {
  private readonly logger = new Logger(SceneTemplateSweepService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
  ) {}

  start(): void {
    void this.safeSweep();
    this.timer = setInterval(() => void this.safeSweep(), TEMPLATE_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async safeSweep(): Promise<void> {
    try {
      const { queued, removed } = await this.sweep();
      if (queued + removed > 0) {
        this.logger.log(
          `Templates de cena: ${queued} enfileirada(s), ${removed} órfão(s) apagado(s)`,
        );
      }
    } catch (error) {
      this.logger.error(`Varredura dos templates de cena falhou: ${(error as Error).message}`);
    }
  }

  /** Uma passada (`batch` cenas no máximo). `queued` conta as cenas escolhidas (o `singletonKey` junta quem já está na fila). */
  async sweep(batch = TEMPLATE_SWEEP_BATCH): Promise<{ queued: number; removed: number }> {
    const removed = await this.removeOrphans();
    const rows: Array<{ id: string }> = await this.dataSource.query(STALE_SCENES_SQL, [
      MAX_SYNC_ATTEMPTS,
      batch,
    ]);
    for (const { id } of rows) {
      await this.queue.publish(
        QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC,
        { sceneId: id },
        { singletonKey: id, retryLimit: TEMPLATE_SYNC_RETRY_LIMIT },
      );
    }
    return { queued: rows.length, removed };
  }

  /** Apaga os templates órfãos e zera os ponteiros pelo helper do espelho, na mesma transação. Devolve quantos saíram. */
  private removeOrphans(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const gone: Array<{ templateId: string; sceneId: string }> =
        await manager.query(ORPHAN_TEMPLATES_SQL);
      const goneIds = new Set(gone.map((row) => row.templateId));
      for (const sceneId of new Set(gone.map((row) => row.sceneId))) {
        const scene = await manager.findOne(TemplateScene, {
          where: { id: sceneId },
          withDeleted: true,
        });
        if (!scene) continue;
        const faces = await loadFaces(manager, sceneId);
        for (const face of faces) {
          const pointed = face.templateId ? goneIds.has(face.templateId) : false;
          const mirrored =
            face.index === 0 && !!scene.approvedTemplateId && goneIds.has(scene.approvedTemplateId);
          if (pointed || mirrored) await setFaceTemplate(manager, scene, face.index, null);
        }
      }
      return gone.length;
    });
  }
}
