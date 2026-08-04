import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo de Animações IA (TDD docs/tdd-modulo-animacoes-ia.md §3):
 * assets, tasks, eventos de auditoria, render jobs, ledger de créditos e
 * catálogo de vozes. Em prod (synchronize off) rodar via migration:run.
 */
export class CreateAnimationsModule1764100000000 implements MigrationInterface {
  name = 'CreateAnimationsModule1764100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "animation_assets" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "kind" varchar(30) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'draft',
        "name" varchar NOT NULL,
        "origin" varchar(20) NOT NULL,
        "sourceTaskId" uuid,
        "fileUrl" varchar,
        "alphaUrl" varchar,
        "posterUrl" varchar,
        "thumbUrl" varchar,
        "mimeType" varchar,
        "width" int,
        "height" int,
        "durationMs" int,
        "fileSize" bigint,
        "hasAlpha" boolean NOT NULL DEFAULT false,
        "contentHash" varchar(64),
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_anim_assets_user_kind" ON "animation_assets" ("userId", "kind", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_anim_assets_content_hash" ON "animation_assets" ("contentHash")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "animation_tasks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "type" varchar(30) NOT NULL,
        "status" varchar(30) NOT NULL DEFAULT 'queued',
        "provider" varchar(20),
        "providerJobId" varchar,
        "input" jsonb NOT NULL,
        "pipeline" jsonb NOT NULL DEFAULT '[]',
        "currentStepIndex" int NOT NULL DEFAULT 0,
        "resultAssetId" uuid,
        "errorCode" varchar(40),
        "errorMessage" text,
        "attempts" int NOT NULL DEFAULT 0,
        "reservedCredits" int NOT NULL DEFAULT 0,
        "consumedCredits" int NOT NULL DEFAULT 0,
        "providerCostUsd" numeric(10,4),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "startedAt" timestamptz,
        "finishedAt" timestamptz
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_anim_tasks_user_status" ON "animation_tasks" ("userId", "status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_anim_tasks_provider_job" ON "animation_tasks" ("provider", "providerJobId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "animation_task_events" (
        "id" bigserial PRIMARY KEY,
        "taskId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "kind" varchar(10) NOT NULL DEFAULT 'task',
        "fromStatus" varchar(30) NOT NULL,
        "toStatus" varchar(30) NOT NULL,
        "detail" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_anim_events_task" ON "animation_task_events" ("taskId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_anim_events_created" ON "animation_task_events" ("createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "render_jobs" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "flyerId" uuid,
        "status" varchar(20) NOT NULL DEFAULT 'queued',
        "progressPct" smallint NOT NULL DEFAULT 0,
        "spec" jsonb NOT NULL,
        "outputAssetId" uuid,
        "errorMessage" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "finishedAt" timestamptz
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_render_jobs_user_status" ON "render_jobs" ("userId", "status", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_credit_ledger" (
        "id" bigserial PRIMARY KEY,
        "userId" uuid NOT NULL,
        "delta" int NOT NULL,
        "reason" varchar(30) NOT NULL,
        "taskId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_credit_ledger_user" ON "ai_credit_ledger" ("userId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_credit_ledger_task" ON "ai_credit_ledger" ("taskId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "voice_catalog" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "providerVoiceId" varchar NOT NULL,
        "name" varchar NOT NULL,
        "language" varchar(10) NOT NULL DEFAULT 'pt-BR',
        "gender" varchar(20),
        "style" varchar(40),
        "previewUrl" varchar,
        "enabled" boolean NOT NULL DEFAULT true,
        "sort" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "voice_catalog"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_credit_ledger"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "render_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "animation_task_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "animation_tasks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "animation_assets"`);
  }
}
