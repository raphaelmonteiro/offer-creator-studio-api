import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Origem, estilo e identidade do kit do personagem (change
 * video-formatos-personagem, design D4/D5):
 *
 * - `mc_character_kits`: `source` (mascot|logo, default mascot), `style`
 *   (cartoon_2d|3d_render|realistic; NULL nos kits anteriores = "herdado"),
 *   `identityMode` (generated|logo_as_is), `identityAssetId` (candidato
 *   escolhido / referência frontal), `tileAssetId` + `tileBackgroundColor`
 *   (tile do personagem) e `candidateRoundId` (rodada corrente). O CHECK
 *   garante que `logo_as_is` só existe com origem `logo`.
 * - `mascots.kind`: o logo da marca é registrado como linha de `mascots` com
 *   `kind = 'logo'`, reaproveitando upload, cliente, direitos e recorte.
 * - `mc_kit_candidates`: candidatos de mascotização por rodada (kit, rodada,
 *   índice, asset, prompt, ajustes do usuário, escolhido).
 *
 * Tudo aditivo e idempotente (IF NOT EXISTS); kits existentes continuam
 * válidos com os defaults e `style` nulo.
 */
export class AddKitSourceStyle1766000000000 implements MigrationInterface {
  name = 'AddKitSourceStyle1766000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "source" varchar(10) NOT NULL DEFAULT 'mascot'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "style" varchar(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "identityMode" varchar(12) NOT NULL DEFAULT 'generated'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "identityAssetId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "tileAssetId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "tileBackgroundColor" varchar(9)`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "candidateRoundId" uuid`,
    );
    // Postgres não tem ADD CONSTRAINT IF NOT EXISTS para CHECK: drop + add é o
    // equivalente idempotente.
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" DROP CONSTRAINT IF EXISTS "CHK_mc_kits_identity_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD CONSTRAINT "CHK_mc_kits_identity_mode" ` +
        `CHECK ("identityMode" = 'generated' OR "source" = 'logo')`,
    );

    await queryRunner.query(
      `ALTER TABLE "mascots" ADD COLUMN IF NOT EXISTS "kind" varchar(10) NOT NULL DEFAULT 'mascot'`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_kit_candidates" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kitId" uuid NOT NULL,
        "roundId" uuid NOT NULL,
        "idx" int NOT NULL,
        "assetId" uuid,
        "prompt" text NOT NULL,
        "adjustments" text,
        "chosen" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_kit_candidates_kit_round" ON "mc_kit_candidates" ("kitId", "roundId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mc_kit_candidates_kit_round"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_kit_candidates"`);

    await queryRunner.query(`ALTER TABLE "mascots" DROP COLUMN IF EXISTS "kind"`);

    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" DROP CONSTRAINT IF EXISTS "CHK_mc_kits_identity_mode"`,
    );
    for (const column of [
      'candidateRoundId',
      'tileBackgroundColor',
      'tileAssetId',
      'identityAssetId',
      'identityMode',
      'style',
      'source',
    ]) {
      await queryRunner.query(`ALTER TABLE "mc_character_kits" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
