import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tile de corpo do kit do personagem (change video-mascote-transparente, D6):
 *
 * - `mc_character_kits.bodyTileAssetId` (uuid, anulável): asset `kit_tile` com a
 *   personagem inteira (mãos e objeto segurado) recortada pelo alfa da identidade.
 *   Calculado sob demanda, sem chamada paga; kits existentes ficam `null`.
 *
 * Aditivo e idempotente (IF NOT EXISTS / IF EXISTS).
 */
export class AddKitBodyTile1767100000000 implements MigrationInterface {
  name = 'AddKitBodyTile1767100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "bodyTileAssetId" uuid NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" DROP COLUMN IF EXISTS "bodyTileAssetId"`,
    );
  }
}
