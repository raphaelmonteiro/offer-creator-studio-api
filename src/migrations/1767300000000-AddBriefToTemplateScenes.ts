import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Conversa do Template Pro (change add-template-scene-conversation): `template_scenes.brief`, a lista do que
 * o cliente pediu (`[{id, text, status: open|done|dropped, sourceMessageId, updatedAt}]`). Nasce `[]`, sem
 * backfill: as cenas anteriores começam sem itens em aberto. Aditiva e idempotente.
 */
export class AddBriefToTemplateScenes1767300000000 implements MigrationInterface {
  name = 'AddBriefToTemplateScenes1767300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "template_scenes" ADD COLUMN IF NOT EXISTS "brief" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "template_scenes" DROP COLUMN IF EXISTS "brief"`);
  }
}
