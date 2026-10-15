import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lotes DotCompany de resultado incerto (openspec/changes/catalogo-dotcompany-ean, D4).
 *
 * Guarda a `Idempotency-Key` e os GTINs exatos do lote enviado, para repetir o
 * mesmo lote com a mesma chave depois de timeout/erro de rede/5xx (replay sem
 * novo débito). Idempotente (IF NOT EXISTS): o `synchronize` de dev pode ter
 * criado a tabela antes.
 */
export class CreateDotcompanyPendingBatches1766500000000 implements MigrationInterface {
  name = 'CreateDotcompanyPendingBatches1766500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dotcompany_pending_batches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "idempotency_key" varchar(64) NOT NULL,
        "gtins" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "attempts" integer NOT NULL DEFAULT 1,
        "last_error" text,
        "credits_recorded" integer,
        CONSTRAINT "PK_dotcompany_pending_batches" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_dotcompany_pending_batches_gtins"
         ON "dotcompany_pending_batches" USING gin ("gtins")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_dotcompany_pending_batches_gtins"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dotcompany_pending_batches"`);
  }
}
