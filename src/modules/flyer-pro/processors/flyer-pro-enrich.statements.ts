import { DataSource, EntityManager } from 'typeorm';
import { criterionSql } from '../domain/flyer-pro-enrich-criteria';
import type {
  EnrichCursor,
  EnrichError,
  EnrichModels,
  EnrichPhase,
  EnrichResult,
  EnrichStep,
  JobStatus,
} from '../domain/flyer-pro-job.types';
import { FlyerProJob } from '../entities/flyer-pro-job.entity';
import type { EnrichItemRow } from './flyer-pro-enrich.types';

/** Os comandos do processador sobre `flyer_pro_jobs` e a leitura do lote em `flyer_pro_items`. */

/**
 * Assume a ficha: o lote só segue se `batchSeq` é o `seq` da mensagem e o job está ativo; sobe `batchSeq`, passa a
 * `running`, grava `startedAt` na primeira vez e o primeiro batimento. Sem linha, o lote já foi assumido por outra
 * entrega ou o job terminou: devolve `null`, e o handler sai sem ler item nem chamar o provedor.
 */
export async function claimBatch(
  dataSource: DataSource,
  jobId: string,
  seq: number,
): Promise<FlyerProJob | null> {
  const [rows] = await dataSource.query(
    `UPDATE "flyer_pro_jobs"
        SET "batchSeq" = "batchSeq" + 1, "status" = 'running', "startedAt" = COALESCE("startedAt", now()),
            "heartbeatAt" = now(), "updatedAt" = now()
      WHERE "id" = $1 AND "batchSeq" = $2 AND "status" IN ('queued', 'running')
      RETURNING *`,
    [jobId, seq],
  );
  return (rows?.[0] as FlyerProJob | undefined) ?? null;
}

/**
 * Atualiza o batimento, só enquanto a ficha do lote é a atual, o job está `running` e o batimento está ligado
 * (`claimBatch` o liga; a gravação, a falha e a republicação o zeram): um batimento que saiu antes da gravação e só
 * chega depois dela não o ressuscita.
 */
export function beat(dataSource: DataSource, jobId: string, seq: number): Promise<unknown> {
  return dataSource.query(
    `UPDATE "flyer_pro_jobs" SET "heartbeatAt" = now()
      WHERE "id" = $1 AND "batchSeq" = $2 AND "status" = 'running' AND "heartbeatAt" IS NOT NULL`,
    [jobId, seq],
  );
}

/** A linha do job com a trava até o fim da transação, ou `null` se foi apagada (expurgo do encarte). */
export function lockJob(manager: EntityManager, jobId: string): Promise<FlyerProJob | null> {
  return manager.findOne(FlyerProJob, {
    where: { id: jobId },
    lock: { mode: 'pessimistic_write' },
  });
}

/** As colunas que o processador grava no job; `clearHeartbeat` zera o batimento e `finish` grava `finishedAt`. */
export interface JobColumns {
  status?: JobStatus;
  phase?: EnrichPhase | null;
  cursor?: EnrichCursor | null;
  total?: number;
  processed?: number;
  result?: EnrichResult;
  models?: EnrichModels | null;
  error?: EnrichError | null;
  batchAttempts?: number;
  clearHeartbeat?: boolean;
  finish?: boolean;
}

const JSONB: ReadonlySet<string> = new Set(['cursor', 'result', 'models', 'error']);
const FLAGS: Record<string, string> = {
  clearHeartbeat: `"heartbeatAt" = NULL`,
  finish: `"finishedAt" = now()`,
};

/** `UPDATE "flyer_pro_jobs"` só das colunas dadas, mais `updatedAt = now()`; nada além do que o tipo permite. */
export async function updateJob(
  manager: EntityManager,
  jobId: string,
  columns: JobColumns,
): Promise<void> {
  const values = Object.entries(columns).filter(([, value]) => value !== undefined);
  const params: unknown[] = [jobId];
  const sets = [`"updatedAt" = now()`];
  for (const [name, value] of values) {
    if (name in FLAGS) {
      if (value) sets.push(FLAGS[name]);
      continue;
    }
    params.push(JSONB.has(name) && value !== null ? JSON.stringify(value) : value);
    sets.push(`"${name}" = $${params.length}${JSONB.has(name) ? '::jsonb' : ''}`);
  }
  await manager.query(`UPDATE "flyer_pro_jobs" SET ${sets.join(', ')} WHERE "id" = $1`, params);
}

const ITEM_COLUMNS = `"id", "position", "name", "sourceName", "category", "categorySource", "categoryReview",
  "spellReview", "unit", "ean", "imported", "imageStatus", "imageOrigin", "imageReview"`;

/** O que a leitura de um lote precisa saber do job e da fase. */
export interface BatchQuery {
  documentId: string;
  itemIds: string[] | null;
  phase: EnrichStep;
  onlyMissing: boolean;
  size: number;
  /** O último item visitado na fase: o lote lê os que vêm depois dele, por `(position, id)`. */
  after: { position: number; id: string } | null;
}

/** O próximo lote da fase, sem trava: os itens do escopo que o critério pega, em ordem de `(position, id)` depois do ponto. */
export async function readBatch(
  manager: EntityManager,
  query: BatchQuery,
): Promise<EnrichItemRow[]> {
  const params: unknown[] = [query.documentId];
  const filters = [`"documentId" = $1`, criterionSql(query.phase, query.onlyMissing)];
  if (query.itemIds) {
    params.push(query.itemIds);
    filters.push(`"id" = ANY($${params.length}::uuid[])`);
  }
  if (query.after) {
    params.push(query.after.position, query.after.id);
    filters.push(`("position", "id") > ($${params.length - 1}::integer, $${params.length}::uuid)`);
  }
  params.push(query.size);
  return manager.query(
    `SELECT ${ITEM_COLUMNS} FROM "flyer_pro_items" WHERE ${filters.join(' AND ')}
      ORDER BY "position", "id" LIMIT $${params.length}`,
    params,
  );
}
