import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Encarte Pro: job de fotos, categorias e ortografia (`flyer_pro_jobs`). O índice único parcial
 * `UQ_flyer_pro_jobs_document_active` garante no banco um job ativo por encarte. `heartbeatAt` é o batimento do lote
 * em execução; `batchSeq` é a ficha que impede um lote de rodar ou gravar duas vezes.
 *
 * Aditiva e idempotente (`IF NOT EXISTS`), vem depois da M1 e da M2 e não toca nenhuma tabela existente. Os nomes de
 * chave e de índice são os da entidade, para o `synchronize` de desenvolvimento não ver diferença.
 */
export class CreateFlyerProJobs1767900000000 implements MigrationInterface {
  name = 'CreateFlyerProJobs1767900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flyer_pro_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "documentId" uuid NOT NULL,
        "steps" jsonb NOT NULL,
        "status" varchar(12) NOT NULL DEFAULT 'queued',
        "phase" varchar(20),
        "cursor" jsonb,
        "total" integer NOT NULL DEFAULT 0,
        "processed" integer NOT NULL DEFAULT 0,
        "itemIds" jsonb,
        "onlyMissing" boolean NOT NULL DEFAULT true,
        "autoApply" boolean NOT NULL DEFAULT true,
        "result" jsonb NOT NULL DEFAULT '{}',
        "error" jsonb,
        "models" jsonb,
        "costUsd" numeric(12,6),
        "batchSeq" integer NOT NULL DEFAULT 0,
        "batchAttempts" smallint NOT NULL DEFAULT 0,
        "heartbeatAt" timestamptz,
        "cancelRequestedAt" timestamptz,
        "createdByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "startedAt" timestamptz,
        "finishedAt" timestamptz,
        CONSTRAINT "PK_flyer_pro_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_flyer_pro_jobs_document" FOREIGN KEY ("documentId")
          REFERENCES "flyer_pro_documents"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_flyer_pro_jobs_document_active" ON "flyer_pro_jobs" ("documentId") WHERE "status" IN ('queued', 'running')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_jobs_document_created" ON "flyer_pro_jobs" ("documentId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_jobs_document_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_flyer_pro_jobs_document_active"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "flyer_pro_jobs"`);
  }
}
