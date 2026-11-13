import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clients: add a `headers` jsonb column holding the client's header LIBRARY — an array of named,
 * reusable headers (`{ id, name, format?, storeId?, section: TemplateSection }`), the sibling of
 * `footers`. Opaque on the server. There is no legacy singular column to mirror.
 *
 * No backfill: nullable → existing rows stay compatible (null reads as an empty library).
 */
export class AddHeadersLibraryToClients1767600000000 implements MigrationInterface {
  name = 'AddHeadersLibraryToClients1767600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "headers" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "headers"`);
  }
}
