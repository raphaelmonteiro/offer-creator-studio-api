import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Módulo de Comerciais com Mascote (docs/plano-comerciais-mascote.md §6.1):
 * kits de personagem, projetos, cenas, steps e eventos de auditoria.
 * Em prod (synchronize off) rodar via migration:run; em dev o synchronize
 * cria o mesmo schema a partir das entidades.
 *
 * Notas de schema (mesmas convenções da migration do módulo de animações):
 * - colunas camelCase entre aspas (TypeORM sem naming strategy custom);
 * - mc_character_kits.mascotId é referência LÓGICA (sem FK física para
 *   mascots) — boundary entre módulos vale também no schema;
 * - mc_steps."inputHash" tem índice PARCIAL em status='succeeded': é o índice
 *   de lookup do cache por hash (plano §6.3);
 * - mc_events.id bigserial é o cursor de replay SSE por usuário.
 */
export class CreateCommercialsModule1765300000000 implements MigrationInterface {
  name = 'CreateCommercialsModule1765300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_character_kits" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "mascotId" uuid NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'generating',
        "canonicalDesc" text,
        "voiceId" text,
        "referenceAssetIds" uuid[] NOT NULL DEFAULT '{}',
        "cutoutAssetId" uuid,
        "version" int NOT NULL DEFAULT 1,
        "moderation" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "approvedAt" timestamptz
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_kits_user_status" ON "mc_character_kits" ("userId", "status")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_projects" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "kitId" uuid NOT NULL,
        "title" varchar(120) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'draft',
        "briefing" text NOT NULL,
        "script" jsonb,
        "aspectRatio" varchar(10) NOT NULL DEFAULT '9:16',
        "targetDurationS" int NOT NULL,
        "soundtrackAssetId" uuid,
        "finalAssetId" uuid,
        "reservedCredits" int NOT NULL DEFAULT 0,
        "consumedCredits" int NOT NULL DEFAULT 0,
        "providerCostUsd" numeric(10,4) NOT NULL DEFAULT 0,
        "errorCode" varchar(40),
        "errorMessage" text,
        "moderation" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "approvedAt" timestamptz,
        "finishedAt" timestamptz,
        CONSTRAINT "FK_mc_projects_kit" FOREIGN KEY ("kitId")
          REFERENCES "mc_character_kits"("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_projects_user_status" ON "mc_projects" ("userId", "status", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_scenes" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "projectId" uuid NOT NULL,
        "idx" int NOT NULL,
        "generation" int NOT NULL DEFAULT 1,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "durationS" int NOT NULL,
        "actionPrompt" text NOT NULL,
        "dialogue" text,
        "keyframeAssetId" uuid,
        "videoAssetId" uuid,
        "audioAssetId" uuid,
        "finalAssetId" uuid,
        "errorCode" varchar(40),
        "errorMessage" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_mc_scenes_project" FOREIGN KEY ("projectId")
          REFERENCES "mc_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_mc_scenes_project_idx" UNIQUE ("projectId", "idx")
      )`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_steps" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "projectId" uuid NOT NULL,
        "sceneId" uuid,
        "sceneGeneration" int,
        "type" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "inputHash" text NOT NULL,
        "provider" text,
        "providerJobId" text,
        "outputAssetId" uuid,
        "costCredits" int NOT NULL DEFAULT 0,
        "providerCostUsd" numeric(10,4),
        "errorClass" varchar(30),
        "errorCode" varchar(40),
        "errorMessage" text,
        "attempts" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "startedAt" timestamptz,
        "finishedAt" timestamptz,
        CONSTRAINT "FK_mc_steps_project" FOREIGN KEY ("projectId")
          REFERENCES "mc_projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_mc_steps_scene" FOREIGN KEY ("sceneId")
          REFERENCES "mc_scenes"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_steps_project_status" ON "mc_steps" ("projectId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_steps_input_hash_succeeded" ON "mc_steps" ("inputHash") WHERE "status" = 'succeeded'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_steps_provider_job" ON "mc_steps" ("provider", "providerJobId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_events" (
        "id" bigserial PRIMARY KEY,
        "userId" uuid NOT NULL,
        "refKind" varchar(10) NOT NULL,
        "refId" uuid NOT NULL,
        "kind" text NOT NULL,
        "fromStatus" varchar(30),
        "toStatus" varchar(30),
        "detail" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_events_user_id" ON "mc_events" ("userId", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_steps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_scenes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_projects"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_character_kits"`);
  }
}
