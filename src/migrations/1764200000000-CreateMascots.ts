import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mascotes (spike docs/spike-mascote-animado.md §6) — Fase 1 "Mascote presente".
 *
 * Notas de schema:
 * - `sourceImageUrl` é IMUTÁVEL: o PNG enviado nunca é alterado. `cutoutUrl` e
 *   `previewUrl` são derivados.
 * - `rig`/`rigVersion` ficam prontos para a Fase 3 (rig 2D) mas NÃO são usados
 *   nesta entrega — o rig é imutável depois de `ready` (§6.1).
 * - `rightsConfirmedAt/By` são requisito legal (risco 4): sem aceite o mascote
 *   nunca chega a `ready`.
 * - Colunas em camelCase entre aspas para seguir a convenção já usada pela
 *   migration do módulo de animações (TypeORM sem naming strategy custom).
 */
export class CreateMascots1764200000000 implements MigrationInterface {
  name = 'CreateMascots1764200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mascots" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "clientId" uuid,
        "name" varchar(120) NOT NULL,
        "sourceImageUrl" varchar NOT NULL,
        "cutoutUrl" varchar,
        "previewUrl" varchar,
        "rig" jsonb NOT NULL DEFAULT '{}',
        "rigVersion" int NOT NULL DEFAULT 1,
        "status" varchar(20) NOT NULL DEFAULT 'draft',
        "width" int,
        "height" int,
        "hasAlpha" boolean NOT NULL DEFAULT false,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "rightsConfirmedAt" timestamptz,
        "rightsConfirmedBy" uuid,
        "archivedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mascots_user_status" ON "mascots" ("userId", "status", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mascots_client" ON "mascots" ("clientId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mascots"`);
  }
}
