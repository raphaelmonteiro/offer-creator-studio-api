import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lote pendente DotCompany, rodada 4 (openspec/changes/catalogo-dotcompany-ean, D4).
 *
 * - `"lastOutcome"`: último desfecho conhecido da chamada com a chave (`timeout` | `network` |
 *   `http_5xx` | `http_4xx`; o 409 em voo não o sobrescreve). Decide, quando a chave vira ORPHANED, se o custo estimado
 *   já lançado é desfeito (5xx/4xx não cobram) ou mantido (timeout/rede: resultado incerto).
 * - `"retryNotBefore"`: depois de 409 `IDEMPOTENCY_IN_FLIGHT` (servidor ainda processando), a chave só é
 *   reenviada a partir daqui (intervalo mínimo de 30 s).
 * - Colunas renomeadas de snake_case para "camelCase" entre aspas, como as tabelas irmãs da change
 *   (`1765900000000`). A `1766500000000` não foi alterada; só renomeia o que ainda existir com o nome antigo.
 */
export class AlignDotcompanyPendingBatches1766600000000 implements MigrationInterface {
  name = 'AlignDotcompanyPendingBatches1766600000000';

  private static readonly RENAMES: Array<[string, string]> = [
    ['idempotency_key', 'idempotencyKey'],
    ['created_at', 'createdAt'],
    ['last_error', 'lastError'],
    ['credits_recorded', 'creditsRecorded'],
  ];

  private async rename(q: QueryRunner, from: string, to: string): Promise<void> {
    await q.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'dotcompany_pending_batches' AND column_name = '${from}')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'dotcompany_pending_batches' AND column_name = '${to}') THEN
          ALTER TABLE "dotcompany_pending_batches" RENAME COLUMN "${from}" TO "${to}";
        END IF;
      END $$`);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [from, to] of AlignDotcompanyPendingBatches1766600000000.RENAMES)
      await this.rename(queryRunner, from, to);
    await queryRunner.query(
      `ALTER TABLE "dotcompany_pending_batches" ADD COLUMN IF NOT EXISTS "lastOutcome" varchar(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "dotcompany_pending_batches" ADD COLUMN IF NOT EXISTS "retryNotBefore" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dotcompany_pending_batches" DROP COLUMN IF EXISTS "retryNotBefore"`,
    );
    await queryRunner.query(
      `ALTER TABLE "dotcompany_pending_batches" DROP COLUMN IF EXISTS "lastOutcome"`,
    );
    for (const [from, to] of AlignDotcompanyPendingBatches1766600000000.RENAMES)
      await this.rename(queryRunner, to, from);
  }
}
