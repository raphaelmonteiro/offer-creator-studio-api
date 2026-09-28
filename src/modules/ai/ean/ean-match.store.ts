import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import type { EanMatchJobStatus } from './ean-match.types';

/** Um item travado há mais que isso é considerado abandonado (processo morreu). */
export const STALE_LOCK_MINUTES = 10;

/**
 * Acesso ao banco do runner de jobs de EAN. Isolado para que o laço de
 * controle seja testável em memória e o SQL (SKIP LOCKED) seja testado contra
 * um Postgres de verdade.
 */
@Injectable()
export class EanMatchStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async jobsEmExecucao(): Promise<EanMatchJob[]> {
    return this.dataSource
      .getRepository(EanMatchJob)
      .find({ where: { status: 'running' }, order: { createdAt: 'ASC' } });
  }

  /**
   * Trava até `limit` itens pendentes do job. Itens travados por um processo
   * que morreu voltam a ser elegíveis depois de STALE_LOCK_MINUTES; itens já
   * decididos (status ≠ pending) nunca voltam — é isso que torna o job
   * retomável sem pagar de novo.
   */
  async travarPendentes(jobId: string, limit: number): Promise<EanMatchItem[]> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      `UPDATE ean_match_items
          SET "lockedAt" = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM ean_match_items
           WHERE "jobId" = $1
             AND status = 'pending'
             AND ("lockedAt" IS NULL OR "lockedAt" < now() - make_interval(mins => $3))
           ORDER BY "rowNumber"
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [jobId, limit, STALE_LOCK_MINUTES],
    );
    const flat = Array.isArray(rows[0]) ? (rows[0] as Array<{ id: string }>) : rows;
    if (flat.length === 0) return [];
    return this.dataSource
      .getRepository(EanMatchItem)
      .createQueryBuilder('i')
      .where('i.id IN (:...ids)', { ids: flat.map((r) => r.id) })
      .orderBy('i.rowNumber', 'ASC')
      .getMany();
  }

  /** Grava o resultado de um item e libera a trava. */
  async salvarItem(itemId: string, patch: Partial<EanMatchItem>, costUsd: number): Promise<void> {
    await this.dataSource
      .getRepository(EanMatchItem)
      .createQueryBuilder()
      .update()
      .set({
        ...(patch as Record<string, unknown>),
        lockedAt: null,
        costUsd: () => `"costUsd" + ${Number(costUsd.toFixed(6))}`,
      })
      .where('id = :id', { id: itemId })
      .execute();
  }

  /** Libera a trava sem decidir (falha transitória; tenta de novo depois). */
  async liberarItem(itemId: string): Promise<void> {
    await this.dataSource.query(`UPDATE ean_match_items SET "lockedAt" = NULL WHERE id = $1`, [
      itemId,
    ]);
  }

  /** Soma custo ao job e devolve o acumulado e o teto. */
  async somarCusto(jobId: string, costUsd: number): Promise<{ custo: number; teto: number }> {
    const rows:
      | Array<Array<{ costUsd: string; costCapUsd: string }>>
      | Array<{
          costUsd: string;
          costCapUsd: string;
        }> = await this.dataSource.query(
      `UPDATE ean_match_jobs SET "costUsd" = "costUsd" + $2, "updatedAt" = now()
        WHERE id = $1 RETURNING "costUsd", "costCapUsd"`,
      [jobId, costUsd.toFixed(6)],
    );
    const row = (Array.isArray(rows[0]) ? rows[0][0] : rows[0]) as {
      costUsd: string;
      costCapUsd: string;
    };
    return { custo: Number(row.costUsd), teto: Number(row.costCapUsd) };
  }

  /** Muda o status só se o job ainda estiver em execução (não atropela uma pausa manual). */
  async mudarStatusSeExecutando(
    jobId: string,
    status: EanMatchJobStatus,
    error: string | null = null,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ean_match_jobs SET status = $2, error = $3, "updatedAt" = now()
        WHERE id = $1 AND status = 'running'`,
      [jobId, status, error],
    );
  }

  async contarAbertos(jobId: string): Promise<number> {
    const [row]: Array<{ n: number }> = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM ean_match_items WHERE "jobId" = $1 AND status = 'pending'`,
      [jobId],
    );
    return row?.n ?? 0;
  }
}
