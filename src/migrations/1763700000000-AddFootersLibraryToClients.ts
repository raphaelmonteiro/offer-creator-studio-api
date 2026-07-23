import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clients: add a `footers` jsonb column holding the client's footer LIBRARY — an array of named,
 * reusable footers (`{ id, name, section: TemplateSection }`). Complements the legacy singular
 * `footer` column, which is kept as the "active" footer (mirrors the first library item) so old
 * consumers reading `client.footer` keep working.
 *
 * Backfill: any existing `footer` becomes the first entry of the new library, so no client loses
 * their current footer. Nullable → existing rows stay compatible.
 */
export class AddFootersLibraryToClients1763700000000 implements MigrationInterface {
  name = 'AddFootersLibraryToClients1763700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "footers" jsonb`);

    // Migra o rodapé único existente para a biblioteca: [{ id, name: 'Rodapé', section: footer }].
    await queryRunner.query(`
      UPDATE "clients"
      SET "footers" = jsonb_build_array(
        jsonb_build_object(
          'id', gen_random_uuid()::text,
          'name', 'Rodapé',
          'section', "footer"
        )
      )
      WHERE "footer" IS NOT NULL AND "footers" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "footers"`);
  }
}
