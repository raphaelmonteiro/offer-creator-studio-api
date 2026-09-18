import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pipeline v2 dos comerciais (ADR-001 §4/§5) — migration ADITIVA, sem
 * backfill: todo projeto existente continua no executor legado
 * (`pipelineVersion` default 1, `quality` NULL, `scriptSceneId` NULL) e os
 * leitores toleram a ausência dos campos novos. Deploy desta migration
 * PRECEDE a criação de projetos no pipeline novo (leitores compatíveis
 * primeiro, registros novos depois).
 *
 * - mc_projects: `pipelineVersion` (executor congelado por projeto),
 *   `revision` (controle otimista + vínculo da aprovação), `quality` (jsonb:
 *   manifestos de preparação/aprovação, orçamentos por fase, timeline).
 * - mc_scenes: `scriptSceneId` (identidade editorial estável), `sceneType`.
 * - mc_steps: `projectRevision` (gate do worker), `phase`, `attempt`
 *   (tentativa lógica) e `inputSnapshot` (inputs imutáveis da requisição).
 *
 * `down` remove só as colunas; nunca rodar com jobs v2 ativos (ADR §5).
 */
export class AddCommercialsPipelineV21765600000000 implements MigrationInterface {
  name = 'AddCommercialsPipelineV21765600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "pipelineVersion" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "quality" jsonb`);

    await queryRunner.query(
      `ALTER TABLE "mc_scenes" ADD COLUMN IF NOT EXISTS "scriptSceneId" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_scenes" ADD COLUMN IF NOT EXISTS "sceneType" varchar(24)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_scenes_project_script_scene" ON "mc_scenes" ("projectId", "scriptSceneId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "mc_steps" ADD COLUMN IF NOT EXISTS "projectRevision" integer`,
    );
    await queryRunner.query(`ALTER TABLE "mc_steps" ADD COLUMN IF NOT EXISTS "phase" varchar(16)`);
    await queryRunner.query(
      `ALTER TABLE "mc_steps" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(`ALTER TABLE "mc_steps" ADD COLUMN IF NOT EXISTS "inputSnapshot" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mc_steps" DROP COLUMN IF EXISTS "inputSnapshot"`);
    await queryRunner.query(`ALTER TABLE "mc_steps" DROP COLUMN IF EXISTS "attempt"`);
    await queryRunner.query(`ALTER TABLE "mc_steps" DROP COLUMN IF EXISTS "phase"`);
    await queryRunner.query(`ALTER TABLE "mc_steps" DROP COLUMN IF EXISTS "projectRevision"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mc_scenes_project_script_scene"`);
    await queryRunner.query(`ALTER TABLE "mc_scenes" DROP COLUMN IF EXISTS "sceneType"`);
    await queryRunner.query(`ALTER TABLE "mc_scenes" DROP COLUMN IF EXISTS "scriptSceneId"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "quality"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "revision"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "pipelineVersion"`);
  }
}
