import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clients: persist contact fields (email/address/phoneFixed/phoneMobile) that were collected in
 * the UI but never stored, and add a `footer` jsonb column holding the client's reusable footer
 * model (a TemplateSection) — applied to encartes/templates/social.
 *
 * All columns are nullable → existing rows stay compatible.
 */
export class AddContactFieldsAndFooterToClients1763600000000
  implements MigrationInterface
{
  name = 'AddContactFieldsAndFooterToClients1763600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "email" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "address" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "phoneFixed" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "phoneMobile" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "footer" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "footer"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "phoneMobile"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "phoneFixed"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "address"`);
    await queryRunner.query(`ALTER TABLE "clients" DROP COLUMN IF EXISTS "email"`);
  }
}
