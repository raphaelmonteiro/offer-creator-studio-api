import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  BudgetDenyReason,
  ImportItemResult,
  ImportJobKind,
  ImportJobStatus,
} from './dotcompany.types';
import { EanImportItem } from './entities/ean-import-item.entity';
import { EanImportJob } from './entities/ean-import-job.entity';

/** Um item travado há mais que isso é considerado abandonado (processo morreu). */
export const STALE_LOCK_MINUTES = 10;

export interface NewImportRow {
  rowNumber: number;
  ean: string;
  description: string;
  /** Linha já decidida no parse (ex.: EAN repetido no arquivo). */
  result?: ImportItemResult;
  reason?: string | null;
}

export interface NewImportJob {
  kind: ImportJobKind;
  fileName?: string | null;
  fileHash?: string | null;
  clientId?: string | null;
  costCapCredits?: number;
  rows: NewImportRow[];
}

export interface ItemOutcome {
  result: ImportItemResult;
  reason?: string | null;
  galleryImageId?: string | null;
}

export type JobCounts = Record<ImportItemResult | 'pending', number>;

/** Normaliza o retorno de UPDATE ... RETURNING do driver pg (às vezes vem aninhado). */
function flatRows<T>(rows: unknown): T[] {
  const list = rows as unknown[];
  return (Array.isArray(list[0]) ? list[0] : list) as T[];
}

/**
 * Acesso ao banco dos jobs de importação DotCompany. Isolado para que o laço
 * do runner seja testável em memória e o SQL (SKIP LOCKED, transições
 * condicionais) seja testado contra um Postgres de verdade.
 */
@Injectable()
export class EanImportStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async buscarPorHash(fileHash: string): Promise<EanImportJob | null> {
    return this.dataSource.getRepository(EanImportJob).findOne({ where: { fileHash } });
  }

  async buscarJob(jobId: string): Promise<EanImportJob | null> {
    return this.dataSource.getRepository(EanImportJob).findOne({ where: { id: jobId } });
  }

  async listarJobs(limit = 50): Promise<EanImportJob[]> {
    return this.dataSource
      .getRepository(EanImportJob)
      .find({ order: { createdAt: 'DESC' }, take: Math.min(Math.max(limit, 1), 200) });
  }

  /** Cria o job e todas as linhas numa transação; linhas já decididas nascem `done`. */
  async criarJob(input: NewImportJob): Promise<EanImportJob> {
    return this.dataSource.transaction(async (manager) => {
      const job = await manager.getRepository(EanImportJob).save({
        kind: input.kind,
        status: 'pending' as ImportJobStatus,
        fileName: input.fileName ?? null,
        fileHash: input.fileHash ?? null,
        clientId: input.clientId ?? null,
        costCapCredits: Math.max(0, Math.round(input.costCapCredits ?? 0)),
        totalRows: input.rows.length,
      });
      const CHUNK = 1000;
      for (let i = 0; i < input.rows.length; i += CHUNK) {
        await manager.getRepository(EanImportItem).insert(
          input.rows.slice(i, i + CHUNK).map((r) => ({
            jobId: job.id,
            rowNumber: r.rowNumber,
            ean: r.ean.slice(0, 32),
            description: r.description ?? '',
            status: r.result ? ('done' as const) : ('pending' as const),
            result: r.result ?? null,
            reason: r.reason ?? null,
          })),
        );
      }
      return job;
    });
  }

  /**
   * Jobs que o runner deve tocar agora: os em execução/pendentes e os que
   * esperavam orçamento com `waitUntil` vencido (reavaliação automática).
   * Os de encarte (`flyer`) vêm primeiro.
   */
  async jobsParaRodar(): Promise<EanImportJob[]> {
    return this.dataSource
      .getRepository(EanImportJob)
      .createQueryBuilder('j')
      .where(`j.status IN ('pending', 'running')`)
      .orWhere(`j.status = 'waiting_budget' AND (j."waitUntil" IS NULL OR j."waitUntil" <= now())`)
      .orderBy(`CASE WHEN j.kind = 'flyer' THEN 0 ELSE 1 END`, 'ASC')
      .addOrderBy('j.createdAt', 'ASC')
      .getMany();
  }

  /**
   * Trava até `limit` itens pendentes. Itens travados por um processo que
   * morreu voltam a ser elegíveis depois de STALE_LOCK_MINUTES; itens `done`
   * nunca voltam — é isso que torna o job retomável sem pagar de novo.
   */
  async travarPendentes(jobId: string, limit: number): Promise<EanImportItem[]> {
    const rows = flatRows<{ id: string }>(
      await this.dataSource.query(
        // CTE: avaliada uma vez só. Com `WHERE id IN (SELECT ... LIMIT)` o
        // planejador pode reavaliar a subconsulta e travar MAIS que `limit` linhas.
        `WITH alvo AS (
           SELECT id FROM ean_import_items
            WHERE "jobId" = $1
              AND status = 'pending'
              AND ("lockedAt" IS NULL OR "lockedAt" < now() - make_interval(mins => $3))
            ORDER BY "rowNumber"
            LIMIT $2
            FOR UPDATE SKIP LOCKED)
         UPDATE ean_import_items i
            SET "lockedAt" = now(), attempts = i.attempts + 1, "updatedAt" = now()
           FROM alvo
          WHERE i.id = alvo.id
          RETURNING i.id`,
        [jobId, limit, STALE_LOCK_MINUTES],
      ),
    );
    if (rows.length === 0) return [];
    return this.dataSource
      .getRepository(EanImportItem)
      .createQueryBuilder('i')
      .where('i.id IN (:...ids)', { ids: rows.map((r) => r.id) })
      .orderBy('i.rowNumber', 'ASC')
      .getMany();
  }

  /** Grava o resultado final de um item e libera a trava. */
  async concluirItem(itemId: string, outcome: ItemOutcome): Promise<void> {
    await this.dataSource.query(
      `UPDATE ean_import_items
          SET status = 'done', result = $2, reason = $3, "galleryImageId" = $4,
              "lockedAt" = NULL, "updatedAt" = now()
        WHERE id = $1`,
      [itemId, outcome.result, outcome.reason ?? null, outcome.galleryImageId ?? null],
    );
  }

  /**
   * Libera a trava sem decidir. `devolverTentativa` desconta a tentativa
   * (espera de orçamento não é falha do item).
   */
  async liberarItens(itemIds: string[], devolverTentativa = false): Promise<void> {
    if (itemIds.length === 0) return;
    await this.dataSource.query(
      `UPDATE ean_import_items
          SET "lockedAt" = NULL,
              attempts = CASE WHEN $2 THEN GREATEST(attempts - 1, 0) ELSE attempts END,
              "updatedAt" = now()
        WHERE id = ANY($1)`,
      [itemIds, devolverTentativa],
    );
  }

  /** Soma créditos ao job e devolve o acumulado e o teto. */
  async somarCusto(jobId: string, credits: number): Promise<{ custo: number; teto: number }> {
    const [row] = flatRows<{ costCredits: number; costCapCredits: number }>(
      await this.dataSource.query(
        `UPDATE ean_import_jobs SET "costCredits" = "costCredits" + $2, "updatedAt" = now()
          WHERE id = $1 RETURNING "costCredits", "costCapCredits"`,
        [jobId, Math.max(0, Math.round(credits))],
      ),
    );
    return { custo: Number(row?.costCredits ?? 0), teto: Number(row?.costCapCredits ?? 0) };
  }

  /**
   * Muda o status só se o atual estiver entre `de` — uma pausa manual nunca é
   * atropelada pelo runner. Devolve se mudou.
   */
  async mudarStatus(
    jobId: string,
    de: ImportJobStatus[],
    para: ImportJobStatus,
    extra: {
      waitReason?: BudgetDenyReason | null;
      waitUntil?: Date | null;
      error?: string | null;
    } = {},
  ): Promise<boolean> {
    const rows = flatRows<{ id: string }>(
      await this.dataSource.query(
        `UPDATE ean_import_jobs
            SET status = $3, "waitReason" = $4, "waitUntil" = $5, error = $6, "updatedAt" = now()
          WHERE id = $1 AND status = ANY($2)
          RETURNING id`,
        [jobId, de, para, extra.waitReason ?? null, extra.waitUntil ?? null, extra.error ?? null],
      ),
    );
    return rows.length > 0;
  }

  async definirTeto(jobId: string, costCapCredits: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE ean_import_jobs SET "costCapCredits" = $2, "updatedAt" = now() WHERE id = $1`,
      [jobId, Math.max(0, Math.round(costCapCredits))],
    );
  }

  async contarAbertos(jobId: string): Promise<number> {
    const [row]: Array<{ n: number }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ean_import_items WHERE "jobId" = $1 AND status = 'pending'`,
      [jobId],
    );
    return row?.n ?? 0;
  }

  async contagens(jobId: string): Promise<JobCounts> {
    const rows: Array<{ k: string; n: number }> = await this.dataSource.query(
      `SELECT CASE WHEN status = 'pending' THEN 'pending' ELSE result END AS k, COUNT(*)::int AS n
         FROM ean_import_items WHERE "jobId" = $1 GROUP BY 1`,
      [jobId],
    );
    const counts: JobCounts = {
      pending: 0,
      imported: 0,
      already_exists: 0,
      no_image: 0,
      not_found: 0,
      invalid: 0,
      internal_use: 0,
      duplicate: 0,
      error: 0,
    };
    for (const r of rows) if (r.k && r.k in counts) counts[r.k as keyof JobCounts] = r.n;
    return counts;
  }

  async listarItens(
    jobId: string,
    filtro: { result?: ImportItemResult | 'pending'; page?: number; limit?: number } = {},
  ): Promise<{ items: EanImportItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(filtro.page ?? 1, 1);
    const limit = Math.min(Math.max(filtro.limit ?? 50, 1), 500);
    const qb = this.dataSource
      .getRepository(EanImportItem)
      .createQueryBuilder('i')
      .where('i.jobId = :jobId', { jobId });
    if (filtro.result === 'pending') qb.andWhere(`i.status = 'pending'`);
    else if (filtro.result) qb.andWhere('i.result = :result', { result: filtro.result });
    const [items, total] = await qb
      .orderBy('i.rowNumber', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, total, page, limit };
  }
}
