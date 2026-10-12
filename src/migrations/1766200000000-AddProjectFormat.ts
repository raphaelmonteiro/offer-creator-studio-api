import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Formatos de vídeo por projeto (change video-formatos-personagem, design D6):
 * migration ADITIVA e idempotente em `mc_projects`, sem backfill — todo projeto
 * existente (v1 e v2) passa a ler `format = 'scenes'` e `tier = 'economico'`
 * pelos defaults; as demais colunas ficam NULL e os leitores toleram a ausência.
 *
 * - `format`: discriminador dos executores novos (`scenes` | `talking_art` |
 *   `offer_carousel`). `pipelineVersion` NÃO é tocado: continua 2 nos formatos
 *   novos (o executor v2 é inalterado).
 * - `tier`: `economico` | `premium` (motor de fala dos formatos novos).
 * - `channel`: `instagram` | `whatsapp` (perfil de encode, D13).
 * - `backgroundArtAssetId`, `layoutPreset`, `logoBox` (jsonb, frações 0..1),
 *   `sourceArt` (jsonb `{kind, id, pageIndex, snapshotHash}`): ponte arte → projeto (D9).
 *
 * `down` remove só as colunas novas.
 */
export class AddProjectFormat1766200000000 implements MigrationInterface {
  name = 'AddProjectFormat1766200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "format" varchar(20) NOT NULL DEFAULT 'scenes'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "tier" varchar(10) NOT NULL DEFAULT 'economico'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "channel" varchar(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "backgroundArtAssetId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "layoutPreset" varchar(40)`,
    );
    await queryRunner.query(`ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "logoBox" jsonb`);
    await queryRunner.query(`ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "sourceArt" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "sourceArt"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "logoBox"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "layoutPreset"`);
    await queryRunner.query(
      `ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "backgroundArtAssetId"`,
    );
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "channel"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "tier"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "format"`);
  }
}
