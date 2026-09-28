import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature 14 — vínculo EAN planilha→galeria com alta confiança
 * (openspec/changes/vinculo-ean-planilha-alta-confianca).
 *
 * - `ean_match_jobs`: uma planilha enviada = um job, retomável e com teto de custo.
 * - `ean_match_items`: uma linha da planilha com candidatas, vetos, referência,
 *   julgamentos da IA, decisão humana e o metadata anterior de cada imagem
 *   gravada (para reverter o job).
 * - `ean_references`: cache por EAN da descrição/foto oficial, reaproveitado
 *   entre jobs.
 *
 * Idempotente (IF NOT EXISTS): em desenvolvimento o `synchronize` pode ter
 * criado as tabelas antes.
 */
export class CreateEanMatchJobs1765800000000 implements MigrationInterface {
  name = 'CreateEanMatchJobs1765800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ean_match_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "fileName" varchar,
        "fileHash" varchar(64) NOT NULL,
        "clientId" uuid,
        "totalRows" integer NOT NULL DEFAULT 0,
        "discardedRows" integer NOT NULL DEFAULT 0,
        "costUsd" numeric(10,4) NOT NULL DEFAULT 0,
        "costCapUsd" numeric(10,4) NOT NULL DEFAULT 0,
        "judgeVersion" varchar(64),
        "error" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ean_match_jobs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ean_match_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "jobId" uuid NOT NULL,
        "rowNumber" integer NOT NULL,
        "ean" varchar(14) NOT NULL,
        "description" text NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'pending',
        "reviewReason" varchar(64),
        "candidates" jsonb NOT NULL DEFAULT '[]',
        "reference" jsonb,
        "judgments" jsonb NOT NULL DEFAULT '[]',
        "aiDecision" jsonb,
        "humanDecision" jsonb,
        "writtenImageIds" jsonb NOT NULL DEFAULT '[]',
        "previousMetadata" jsonb,
        "isCalibration" boolean NOT NULL DEFAULT false,
        "costUsd" numeric(10,4) NOT NULL DEFAULT 0,
        "attempts" integer NOT NULL DEFAULT 0,
        "lockedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ean_match_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ean_match_items_job" FOREIGN KEY ("jobId")
          REFERENCES "ean_match_jobs" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ean_match_items_job_status" ON "ean_match_items" ("jobId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ean_match_items_ean" ON "ean_match_items" ("ean")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ean_references" (
        "ean" varchar(14) NOT NULL,
        "source" varchar(16) NOT NULL,
        "name" text,
        "brand" text,
        "quantity" text,
        "imageUrl" text,
        "raw" jsonb,
        "fetchedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ean_references" PRIMARY KEY ("ean")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ean_references"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ean_match_items_ean"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ean_match_items_job_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ean_match_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ean_match_jobs"`);
  }
}
