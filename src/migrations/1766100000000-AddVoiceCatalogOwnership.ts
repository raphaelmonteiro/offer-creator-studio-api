import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vozes por tenant (change video-formatos-personagem, D10): `voice_catalog`
 * ganha `curated` (flag que o sync com a ElevenLabs já calculava só em
 * memória) e `ownerUserId` (dono de uma voz clonada para um usuário). O
 * predicado de visibilidade — `enabled AND (curated OR ownerUserId = :userId)`
 * — vive em src/shared/voice/voice-visibility.ts e vale para as duas rotas
 * que listam vozes (commercials e animations).
 *
 * Backfill: as linhas curadas existentes têm `sort` < 100 (as não curadas
 * entram a partir de UNCURATED_SORT_BASE = 100 em mc-voices.service.ts), então
 * já saem da migration com `curated = true`; sem isso, até o próximo sync
 * bem-sucedido TODAS as vozes ficariam ocultas e os kits aprovados falhariam no
 * TTS. O sync continua sendo a fonte de verdade e corrige o flag na subida.
 *
 * Idempotente (IF NOT EXISTS / IF EXISTS); `down` remove índice e colunas.
 */
export class AddVoiceCatalogOwnership1766100000000 implements MigrationInterface {
  name = 'AddVoiceCatalogOwnership1766100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "voice_catalog" ADD COLUMN IF NOT EXISTS "curated" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "voice_catalog" ADD COLUMN IF NOT EXISTS "ownerUserId" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_voice_catalog_owner_user" ON "voice_catalog" ("ownerUserId")`,
    );
    await queryRunner.query(
      `UPDATE "voice_catalog" SET "curated" = true WHERE "curated" = false AND "sort" < 100`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_voice_catalog_owner_user"`);
    await queryRunner.query(`ALTER TABLE "voice_catalog" DROP COLUMN IF EXISTS "ownerUserId"`);
    await queryRunner.query(`ALTER TABLE "voice_catalog" DROP COLUMN IF EXISTS "curated"`);
  }
}
