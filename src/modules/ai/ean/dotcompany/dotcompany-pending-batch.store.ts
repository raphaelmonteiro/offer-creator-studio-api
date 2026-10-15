import { DataSource } from 'typeorm';

/** A DotCompany garante o replay de uma Idempotency-Key por pelo menos 24 h. */
export const PENDING_BATCH_MAX_AGE_MS = 24 * 3_600_000;
/** Depois de tantas chamadas com a mesma chave sem resposta conclusiva, o lote é abandonado. */
export const PENDING_BATCH_MAX_ATTEMPTS = 5;

export interface PendingBatchRow {
  id: string;
  key: string;
  gtins: string[];
  attempts: number;
  creditsRecorded: number | null;
}

interface RawRow {
  id: string;
  idempotency_key: string;
  gtins: string[];
  attempts: number;
  credits_recorded: number | null;
}

function toRow(r: RawRow): PendingBatchRow {
  return {
    id: r.id,
    key: r.idempotency_key,
    gtins: r.gtins,
    attempts: r.attempts,
    creditsRecorded: r.credits_recorded,
  };
}

/** Lotes pagos de resultado incerto (tabela `dotcompany_pending_batches`). */
export class DotcompanyPendingBatchStore {
  constructor(private readonly dataSource: DataSource) {}

  /** Lotes ainda repetíveis que contêm algum dos EANs. Descarta os mais velhos que 24 h. */
  async findFor(eans: string[], now: Date): Promise<PendingBatchRow[]> {
    if (eans.length === 0) return [];
    await this.dataSource.query(`DELETE FROM dotcompany_pending_batches WHERE created_at < $1`, [
      new Date(now.getTime() - PENDING_BATCH_MAX_AGE_MS),
    ]);
    const rows: RawRow[] = await this.dataSource.query(
      `SELECT id, idempotency_key, gtins, attempts, credits_recorded
         FROM dotcompany_pending_batches WHERE gtins ?| $1::text[] ORDER BY created_at`,
      [eans],
    );
    return rows.map(toRow);
  }

  /** Grava o lote ANTES de enviar: um reinício do processo no meio da chamada ainda o encontra. */
  async create(key: string, gtins: string[], now: Date): Promise<PendingBatchRow> {
    const [r]: RawRow[] = await this.dataSource.query(
      `INSERT INTO dotcompany_pending_batches (idempotency_key, gtins, created_at)
       VALUES ($1, $2::jsonb, $3)
       RETURNING id, idempotency_key, gtins, attempts, credits_recorded`,
      [key, JSON.stringify(gtins), now],
    );
    return toRow(r);
  }

  async addAttempt(id: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_pending_batches SET attempts = attempts + 1 WHERE id = $1`,
      [id],
    );
  }

  async setError(id: string, message: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_pending_batches SET last_error = $2 WHERE id = $1`,
      [id, message.slice(0, 1000)],
    );
  }

  async setRecorded(id: string, credits: number): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_pending_batches SET credits_recorded = $2 WHERE id = $1`,
      [id, credits],
    );
  }

  async remove(id: string): Promise<void> {
    await this.dataSource.query(`DELETE FROM dotcompany_pending_batches WHERE id = $1`, [id]);
  }
}
