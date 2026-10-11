import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catálogo DotCompany por EAN (openspec/changes/catalogo-dotcompany-ean).
 *
 * - `dotcompany_lookups`: cache por EAN da resposta da DotCompany (paga uma vez),
 *   com ETag, status e a foto importada para a galeria.
 * - `ean_import_jobs` / `ean_import_items`: importação retomável de um cadastro
 *   de cliente (`kind = 'file'`) ou dos EANs de um encarte que não terminaram no
 *   prazo da requisição (`kind = 'flyer'`).
 * - `dotcompany_usage_hourly`: consumo por hora (fuso America/Sao_Paulo), base
 *   dos limites próprios por hora/dia e do relatório.
 * - `dotcompany_balance`: saldo conhecido (linha única) e controle dos alertas.
 * - Índice único parcial em `gallery_images`: no máximo uma foto DotCompany
 *   "exata" por EAN.
 *
 * Idempotente (IF NOT EXISTS): em desenvolvimento o `synchronize` pode ter
 * criado as tabelas antes.
 */
export class CreateDotcompanyImport1765900000000 implements MigrationInterface {
  name = 'CreateDotcompanyImport1765900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dotcompany_lookups" (
        "ean" varchar(14) NOT NULL,
        "status" varchar(16) NOT NULL,
        "raw" jsonb,
        "etag" varchar(256),
        "fetchedAt" timestamptz NOT NULL DEFAULT now(),
        "retryAfter" timestamptz,
        "galleryImageId" uuid,
        "lastError" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_dotcompany_lookups" PRIMARY KEY ("ean")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ean_import_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "kind" varchar(8) NOT NULL DEFAULT 'file',
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "waitReason" varchar(16),
        "waitUntil" timestamptz,
        "fileName" varchar,
        "fileHash" varchar(64),
        "clientId" uuid,
        "totalRows" integer NOT NULL DEFAULT 0,
        "costCredits" integer NOT NULL DEFAULT 0,
        "costCapCredits" integer NOT NULL DEFAULT 0,
        "error" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ean_import_jobs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ean_import_jobs_fileHash"
         ON "ean_import_jobs" ("fileHash") WHERE "fileHash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ean_import_jobs_status" ON "ean_import_jobs" ("status")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ean_import_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "jobId" uuid NOT NULL,
        "rowNumber" integer NOT NULL,
        "ean" varchar(32) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "result" varchar(24),
        "reason" text,
        "galleryImageId" uuid,
        "attempts" integer NOT NULL DEFAULT 0,
        "lockedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ean_import_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ean_import_items_job" FOREIGN KEY ("jobId")
          REFERENCES "ean_import_jobs" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ean_import_items_job_status" ON "ean_import_items" ("jobId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ean_import_items_job_result" ON "ean_import_items" ("jobId", "result")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dotcompany_usage_hourly" (
        "hour" timestamptz NOT NULL,
        "requests" integer NOT NULL DEFAULT 0,
        "credits" integer NOT NULL DEFAULT 0,
        "found" integer NOT NULL DEFAULT 0,
        "notFound" integer NOT NULL DEFAULT 0,
        "errors" integer NOT NULL DEFAULT 0,
        "interactiveRequests" integer NOT NULL DEFAULT 0,
        "batchRequests" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_dotcompany_usage_hourly" PRIMARY KEY ("hour")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "dotcompany_balance" (
        "id" smallint NOT NULL DEFAULT 1,
        "available" integer,
        "checkedAt" timestamptz,
        "lowAlertSentAt" timestamptz,
        "emptyAlertSentAt" timestamptz,
        "dayLimitAlertDay" date,
        CONSTRAINT "PK_dotcompany_balance" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_dotcompany_balance_single_row" CHECK ("id" = 1)
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_gallery_images_dotcompany_ean"
         ON "gallery_images" ((metadata->>'ean'))
         WHERE metadata->>'eanSource' = 'dotcompany' AND metadata->>'eanVerifiedBy' = 'exact'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_gallery_images_dotcompany_ean"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dotcompany_balance"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dotcompany_usage_hourly"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ean_import_items_job_result"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ean_import_items_job_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ean_import_items"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ean_import_jobs_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ean_import_jobs_fileHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ean_import_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "dotcompany_lookups"`);
  }
}
