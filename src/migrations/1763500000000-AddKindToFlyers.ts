import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `kind` column to the `flyers` table to discriminate between
 * traditional flyers and social media art (Instagram, Story, WhatsApp, etc).
 *
 * Default `'flyer'` keeps all existing rows compatible with the previous behavior.
 */
export class AddKindToFlyers1763500000000 implements MigrationInterface {
  name = 'AddKindToFlyers1763500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flyers" ADD COLUMN IF NOT EXISTS "kind" varchar(20) NOT NULL DEFAULT 'flyer'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyers_kind" ON "flyers" ("kind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyers_kind"`);
    await queryRunner.query(`ALTER TABLE "flyers" DROP COLUMN IF EXISTS "kind"`);
  }
}
