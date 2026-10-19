import { MigrationInterface, QueryRunner } from 'typeorm';

/** O editor V2 precisa desta tabela também com synchronize desligado em produção. */
export class CreateFlyerBuilderV2Documents1766800000000 implements MigrationInterface {
  name = 'CreateFlyerBuilderV2Documents1766800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flyer_builder_v2_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "clientId" uuid,
        "thumbnailUrl" varchar,
        "status" varchar(20) NOT NULL DEFAULT 'draft',
        "schemaVersion" integer NOT NULL DEFAULT 2,
        "builder" varchar(50) NOT NULL DEFAULT 'flyer-builder-v2',
        "document" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flyer_builder_v2_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_flyer_builder_v2_documents_client" FOREIGN KEY ("clientId")
          REFERENCES "clients" ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "flyer_builder_v2_documents"`);
  }
}
