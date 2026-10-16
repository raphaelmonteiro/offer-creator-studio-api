import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lote pendente DotCompany, rodada 5 (openspec/changes/catalogo-dotcompany-ean, D13, R29).
 * `"creditsRecordedAt"`: instante em que o custo estimado foi lançado no consumo. O estorno volta para a hora
 * desse lançamento (não para as horas mais recentes) e só devolve ao saldo se ele não foi conferido depois.
 * Pendentes já existentes com estimado lançado recebem `"createdAt"` (o lançamento ocorre na 1ª chamada).
 */
export class AddCreditsRecordedAtToDotcompanyPendingBatches1766700000000 implements MigrationInterface {
  name = 'AddCreditsRecordedAtToDotcompanyPendingBatches1766700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dotcompany_pending_batches" ADD COLUMN IF NOT EXISTS "creditsRecordedAt" timestamptz`,
    );
    await queryRunner.query(
      `UPDATE "dotcompany_pending_batches" SET "creditsRecordedAt" = "createdAt"
        WHERE "creditsRecorded" IS NOT NULL AND "creditsRecordedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dotcompany_pending_batches" DROP COLUMN IF EXISTS "creditsRecordedAt"`,
    );
  }
}
