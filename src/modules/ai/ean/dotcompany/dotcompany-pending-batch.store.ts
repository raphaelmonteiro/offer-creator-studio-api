import { DataSource } from 'typeorm';
import type { PendingBatchOutcome } from './entities/dotcompany-pending-batch.entity';

/** A DotCompany garante o replay de uma Idempotency-Key por pelo menos 24 h. */
export const PENDING_BATCH_MAX_AGE_MS = 24 * 3_600_000;
/** Depois de tantas chamadas com a mesma chave sem resposta conclusiva, o lote é abandonado. */
export const PENDING_BATCH_MAX_ATTEMPTS = 5;
/** Intervalo mínimo para reenviar uma chave que acabou de dar 409 `IDEMPOTENCY_IN_FLIGHT` (ainda processando). */
export const IN_FLIGHT_RETRY_MS = 30_000;

export interface PendingBatchRow {
  id: string;
  key: string;
  gtins: string[];
  attempts: number;
  creditsRecorded: number | null;
  lastOutcome: PendingBatchOutcome | null;
  retryNotBefore: Date | null;
}

interface RawRow {
  id: string;
  idempotencyKey: string;
  gtins: string[];
  attempts: number;
  creditsRecorded: number | null;
  lastOutcome: PendingBatchOutcome | null;
  retryNotBefore: Date | null;
}

const COLUMNS = `id, "idempotencyKey", gtins, attempts, "creditsRecorded", "lastOutcome", "retryNotBefore"`;

function toRow(r: RawRow): PendingBatchRow {
  return {
    id: r.id,
    key: r.idempotencyKey,
    gtins: r.gtins,
    attempts: r.attempts,
    creditsRecorded: r.creditsRecorded,
    lastOutcome: r.lastOutcome,
    retryNotBefore: r.retryNotBefore,
  };
}

/** Lotes pagos de resultado incerto (tabela `dotcompany_pending_batches`). */
export class DotcompanyPendingBatchStore {
  constructor(private readonly dataSource: DataSource) {}

  /** Lotes ainda repetíveis que contêm algum dos EANs. Descarta os mais velhos que 24 h. */
  async findFor(eans: string[], now: Date): Promise<PendingBatchRow[]> {
    if (eans.length === 0) return [];
    await this.dataSource.query(`DELETE FROM dotcompany_pending_batches WHERE "createdAt" < $1`, [
      new Date(now.getTime() - PENDING_BATCH_MAX_AGE_MS),
    ]);
    const rows: RawRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM dotcompany_pending_batches WHERE gtins ?| $1::text[] ORDER BY "createdAt"`,
      [eans],
    );
    return rows.map(toRow);
  }

  /** Grava o lote ANTES de enviar: um reinício do processo no meio da chamada ainda o encontra. */
  async create(key: string, gtins: string[], now: Date): Promise<PendingBatchRow> {
    const [r]: RawRow[] = await this.dataSource.query(
      `INSERT INTO dotcompany_pending_batches ("idempotencyKey", gtins, "createdAt")
       VALUES ($1, $2::jsonb, $3)
       RETURNING ${COLUMNS}`,
      [key, JSON.stringify(gtins), now],
    );
    return toRow(r);
  }

  /**
   * Conta mais uma chamada com a chave e devolve o estado ATUAL da linha, ou `null` se outro chamador a
   * apagou (lote já fechado): quem recebe `null` não reenvia, relê o cache.
   */
  async startResend(id: string): Promise<PendingBatchRow | null> {
    // UPDATE/DELETE com RETURNING: o driver devolve `[linhas, quantidade]`.
    const [rows]: [RawRow[], number] = await this.dataSource.query(
      `UPDATE dotcompany_pending_batches SET attempts = attempts + 1, "retryNotBefore" = NULL
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id],
    );
    return rows.length ? toRow(rows[0]) : null;
  }

  /** Guarda o desfecho da chamada (timeout, rede, 5xx, 4xx como 429) e libera o reenvio imediato. */
  async setOutcome(id: string, outcome: PendingBatchOutcome, message: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_pending_batches
          SET "lastOutcome" = $2, "lastError" = $3, "retryNotBefore" = NULL WHERE id = $1`,
      [id, outcome, message.slice(0, 1000)],
    );
  }

  /**
   * 409 `IDEMPOTENCY_IN_FLIGHT`: o servidor ainda processa a chave. Não é desfecho (o último conhecido
   * continua valendo) e não gasta tentativa: a espera do ORPHANED (3 min) dura mais que 5 intervalos de 30 s.
   */
  async deferInFlight(id: string, until: Date, message: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_pending_batches
          SET "retryNotBefore" = $2, "lastError" = $3, attempts = GREATEST(attempts - 1, 1) WHERE id = $1`,
      [id, until, message.slice(0, 1000)],
    );
  }

  async setRecorded(id: string, credits: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_pending_batches SET "creditsRecorded" = $2 WHERE id = $1`,
      [id, credits],
    );
  }

  /** Apaga o lote e diz se ele ainda existia (quem apaga primeiro é quem contabiliza). */
  async remove(id: string): Promise<boolean> {
    const [, count]: [unknown[], number] = await this.dataSource.query(
      `DELETE FROM dotcompany_pending_batches WHERE id = $1 RETURNING id`,
      [id],
    );
    return count > 0;
  }
}
