import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Encarte Pro (integração com o backend): o encarte (`flyer_pro_documents`) e os itens de oferta
 * (`flyer_pro_items`).
 *
 * Aditiva e idempotente. Não toca `flyers` nem `flyer_builder_v2_documents`. Os nomes de índice e de FK são os mesmos
 * das entidades, para o `synchronize` de desenvolvimento não ver diferença. Sem CHECK: os valores são validados no
 * código. Referências sem FK (de propósito): `sceneId` (a cena pode ser excluída; o encarte tem `templateSnapshot`),
 * `galleryImageId` (a foto pode ser excluída; o item tem `imageUrl`), `createdByUserId` e `updatedByUserId`. A coluna
 * `flyer_pro_items.importId` e a FK dela entram na migration que cria `flyer_pro_imports`.
 */
export class CreateFlyerProDocuments1767700000000 implements MigrationInterface {
  name = 'CreateFlyerProDocuments1767700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A busca da lista usa unaccent(); hoje a extensão só nasce no boot da Galeria.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flyer_pro_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar(120) NOT NULL,
        "clientId" uuid NOT NULL,
        "sceneId" uuid NOT NULL,
        "format" varchar(8) NOT NULL,
        "pageCount" smallint NOT NULL,
        "pagesFrozen" boolean NOT NULL DEFAULT false,
        "step" varchar(16) NOT NULL DEFAULT 'products',
        "ui" jsonb NOT NULL DEFAULT '{}',
        "templateSnapshot" jsonb NOT NULL,
        "frame" jsonb NOT NULL DEFAULT '{}',
        "structure" jsonb NOT NULL DEFAULT '{}',
        "card" jsonb NOT NULL DEFAULT '{}',
        "assembly" jsonb NOT NULL DEFAULT '{}',
        "exportPrefs" jsonb NOT NULL DEFAULT '{}',
        "layoutSnapshot" jsonb,
        "layoutDigest" varchar(64),
        "renderDigest" varchar(64),
        "schemaVersion" integer NOT NULL DEFAULT 1,
        "engineVersion" integer NOT NULL,
        "revision" integer NOT NULL DEFAULT 0,
        "lastMutationId" uuid,
        "creationKey" uuid,
        "createdByUserId" uuid,
        "updatedByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CONSTRAINT "PK_flyer_pro_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_flyer_pro_documents_client" FOREIGN KEY ("clientId")
          REFERENCES "clients"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_documents_list" ON "flyer_pro_documents" ("updatedAt") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_documents_client" ON "flyer_pro_documents" ("clientId", "updatedAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_flyer_pro_documents_creation_key" ON "flyer_pro_documents" ("creationKey") WHERE "creationKey" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flyer_pro_items" (
        "id" uuid NOT NULL,
        "documentId" uuid NOT NULL,
        "position" integer NOT NULL,
        "name" varchar(120) NOT NULL,
        "sourceName" varchar(255),
        "price" jsonb NOT NULL,
        "unit" varchar(8) NOT NULL,
        "category" varchar(40),
        "categorySource" varchar(12),
        "categoryReview" jsonb,
        "isAlcoholic" boolean NOT NULL DEFAULT false,
        "ean" varchar(14),
        "galleryImageId" uuid,
        "imageUrl" varchar(1000),
        "imageWidth" integer,
        "imageHeight" integer,
        "imageOrigin" varchar(16),
        "imageStatus" varchar(16) NOT NULL DEFAULT 'none',
        "imageReview" jsonb,
        "spellReview" jsonb,
        "imported" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flyer_pro_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_flyer_pro_items_document" FOREIGN KEY ("documentId")
          REFERENCES "flyer_pro_documents"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_items_document_position" ON "flyer_pro_items" ("documentId", "position")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_items_document_updated" ON "flyer_pro_items" ("documentId", "updatedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_items_gallery_image" ON "flyer_pro_items" ("galleryImageId") WHERE "galleryImageId" IS NOT NULL`,
    );
  }

  /** Mantém a extensão `unaccent`: a Galeria a usa. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_items_gallery_image"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_items_document_updated"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_items_document_position"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "flyer_pro_items"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_flyer_pro_documents_creation_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_documents_client"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_documents_list"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "flyer_pro_documents"`);
  }
}
