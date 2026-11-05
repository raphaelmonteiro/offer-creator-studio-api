import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cena de template (change add-template-scene-persistence, estágio 3 do Template Pro):
 *
 * - `template_scenes`: o contêiner (formato, tamanho nativo, versão atual, `revision` do lock
 *   otimista, custo acumulado, exclusão lógica);
 * - `template_scene_versions`: uma linha por versão; o índice único parcial `UQ_tsv_scene_busy`
 *   garante no banco que só há uma versão `queued`/`running` por cena (D-3);
 * - `template_scene_assets`: arquivos em `uploads/template-scenes/`, com `expiresAt` (GC) e
 *   `purgedAt` (arquivo apagado);
 * - `template_scene_messages`: o chat da cena.
 *
 * Aditiva e idempotente. Os nomes de índice e de FK são os mesmos das entidades, para o
 * `synchronize` do ambiente de desenvolvimento não ver diferença. Sem CHECK: o `synchronize`
 * apagaria as constraints que a entidade não declara; os valores são validados no código.
 * Referências sem FK (de propósito): `currentVersionId`, `parentVersionId`, `masterAssetId`,
 * `previewAssetId` (ciclo entre cena, versão e asset), `createdByUserId` (lógica, D-6) e
 * `template_scene_messages.versionId`.
 */
export class CreateTemplateScenes1767200000000 implements MigrationInterface {
  name = 'CreateTemplateScenes1767200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "template_scenes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar(120) NOT NULL,
        "formatId" varchar(64) NOT NULL,
        "artWidthCm" numeric(8,2) NOT NULL,
        "artHeightCm" numeric(8,2) NOT NULL,
        "widthPx" integer NOT NULL,
        "heightPx" integer NOT NULL,
        "pixelsPerCm" numeric(10,4) NOT NULL,
        "currentVersionId" uuid,
        "revision" integer NOT NULL DEFAULT 0,
        "createdByUserId" uuid,
        "approvedAt" timestamptz,
        "approvedTemplateId" uuid,
        "derivedFromSceneId" uuid,
        "totalCostUsd" numeric(12,6) NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CONSTRAINT "PK_template_scenes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_template_scenes_deleted_updated" ON "template_scenes" ("deletedAt", "updatedAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "template_scene_versions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sceneId" uuid NOT NULL,
        "parentVersionId" uuid,
        "number" integer NOT NULL,
        "operation" varchar(20) NOT NULL,
        "status" varchar(12) NOT NULL,
        "step" varchar(20),
        "cancelRequestedAt" timestamptz,
        "requestedRegion" jsonb,
        "requestedMask" jsonb,
        "targetElementId" varchar(64),
        "elements" jsonb NOT NULL DEFAULT '[]',
        "metrics" jsonb NOT NULL DEFAULT '{}',
        "masterAssetId" uuid,
        "previewAssetId" uuid,
        "providerCostUsd" numeric(12,6) NOT NULL DEFAULT 0,
        "latencyMs" integer,
        "errorCode" varchar(40),
        "correlationId" uuid NOT NULL,
        "isOpenManual" boolean NOT NULL DEFAULT false,
        "approvedAt" timestamptz,
        "createdByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_template_scene_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tsv_scene" FOREIGN KEY ("sceneId") REFERENCES "template_scenes"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tsv_scene_number" ON "template_scene_versions" ("sceneId", "number")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tsv_scene_status" ON "template_scene_versions" ("sceneId", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tsv_scene_busy" ON "template_scene_versions" ("sceneId") WHERE "status" IN ('queued', 'running')`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "template_scene_assets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "versionId" uuid NOT NULL,
        "sceneId" uuid NOT NULL,
        "role" varchar(16) NOT NULL,
        "url" varchar(500) NOT NULL,
        "width" integer,
        "height" integer,
        "bytes" integer NOT NULL DEFAULT 0,
        "expiresAt" timestamptz,
        "purgedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_template_scene_assets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tsa_version" FOREIGN KEY ("versionId") REFERENCES "template_scene_versions"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tsa_expires" ON "template_scene_assets" ("expiresAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tsa_scene" ON "template_scene_assets" ("sceneId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "template_scene_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sceneId" uuid NOT NULL,
        "versionId" uuid,
        "role" varchar(10) NOT NULL,
        "content" text NOT NULL,
        "attachments" jsonb NOT NULL DEFAULT '[]',
        "status" varchar(10) NOT NULL DEFAULT 'done',
        "createdByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_template_scene_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tsm_scene" FOREIGN KEY ("sceneId") REFERENCES "template_scenes"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tsm_scene_created" ON "template_scene_messages" ("sceneId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "template_scene_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "template_scene_assets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "template_scene_versions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "template_scenes"`);
  }
}
