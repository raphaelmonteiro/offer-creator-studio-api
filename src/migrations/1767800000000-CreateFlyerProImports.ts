import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Encarte Pro: histórico de planilhas importadas (`flyer_pro_imports`) e a ligação do item com a importação que o
 * criou (`flyer_pro_items.importId`, com FK `ON DELETE SET NULL`).
 *
 * Aditiva e idempotente. Não toca `flyers`, `flyer_builder_v2_documents` nem a M1. Os nomes de chave e de índice são
 * os das entidades, para o `synchronize` de desenvolvimento não ver diferença. O Postgres não tem
 * `ADD CONSTRAINT IF NOT EXISTS`, por isso a FK de `importId` entra por um bloco DO, para o `up` poder rodar duas
 * vezes. O bloco confere o nome **e a tabela**: `pg_constraint` vale para o banco inteiro, e um banco com dois schemas
 * (o `public` do `chroma_x_e2e` já tem essa FK pelas entidades) pularia a criação no schema novo se só o nome fosse
 * conferido.
 */
export class CreateFlyerProImports1767800000000 implements MigrationInterface {
  name = 'CreateFlyerProImports1767800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flyer_pro_imports" (
        "id" uuid NOT NULL,
        "documentId" uuid NOT NULL,
        "fileName" varchar(255) NOT NULL,
        "fileKind" varchar(8) NOT NULL,
        "fileHash" varchar(64) NOT NULL,
        "detectedFormat" varchar(16),
        "mode" varchar(8) NOT NULL,
        "rowCount" integer NOT NULL,
        "acceptedCount" integer NOT NULL,
        "rejected" jsonb NOT NULL DEFAULT '[]',
        "createdByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flyer_pro_imports" PRIMARY KEY ("id"),
        CONSTRAINT "FK_flyer_pro_imports_document" FOREIGN KEY ("documentId")
          REFERENCES "flyer_pro_documents"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_imports_document_hash" ON "flyer_pro_imports" ("documentId", "fileHash")`,
    );

    await queryRunner.query(
      `ALTER TABLE "flyer_pro_items" ADD COLUMN IF NOT EXISTS "importId" uuid`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'FK_flyer_pro_items_import'
             AND conrelid = '"flyer_pro_items"'::regclass
        ) THEN
          ALTER TABLE "flyer_pro_items" ADD CONSTRAINT "FK_flyer_pro_items_import"
            FOREIGN KEY ("importId") REFERENCES "flyer_pro_imports"("id") ON DELETE SET NULL;
        END IF;
      END
      $$
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_items_import" ON "flyer_pro_items" ("importId") WHERE "importId" IS NOT NULL`,
    );
  }

  /** Apaga o histórico e a ligação dos itens; a M1 fica como estava (as duas tabelas, as chaves e os seis índices). */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_items_import"`);
    await queryRunner.query(
      `ALTER TABLE "flyer_pro_items" DROP CONSTRAINT IF EXISTS "FK_flyer_pro_items_import"`,
    );
    await queryRunner.query(`ALTER TABLE "flyer_pro_items" DROP COLUMN IF EXISTS "importId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_imports_document_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "flyer_pro_imports"`);
  }
}
