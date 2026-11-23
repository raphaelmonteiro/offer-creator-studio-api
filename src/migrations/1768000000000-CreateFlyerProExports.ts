import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Encarte Pro: histórico das exportações (`flyer_pro_exports`, M4).
 *
 * Aditiva e idempotente. Não toca `flyers`, `flyer_builder_v2_documents`, a M1 nem a M2. O `id` vem do front (o registro
 * é idempotente por ele), por isso a chave não tem padrão. Nesta fase nenhum arquivo é guardado: `filePath` fica nulo e
 * `fileState` fica `'not_stored'` (PU-50). `preflight` guarda só a contagem (`{ problems, warnings, infos }`) e não
 * barra a exportação (PU-47 e PU-48). `createdByUserId` é referência lógica, sem FK. Os nomes de chave e de índice são
 * os da entidade, para o `synchronize` de desenvolvimento não ver diferença.
 */
export class CreateFlyerProExports1768000000000 implements MigrationInterface {
  name = 'CreateFlyerProExports1768000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "flyer_pro_exports" (
        "id" uuid NOT NULL,
        "documentId" uuid NOT NULL,
        "documentRevision" integer NOT NULL,
        "engineVersion" integer NOT NULL,
        "renderDigest" varchar(64),
        "format" varchar(8) NOT NULL,
        "options" jsonb NOT NULL DEFAULT '{}',
        "fileName" varchar(200) NOT NULL,
        "fileSize" bigint,
        "preflight" jsonb,
        "filePath" varchar(500),
        "fileState" varchar(16) NOT NULL DEFAULT 'not_stored',
        "createdByUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_flyer_pro_exports" PRIMARY KEY ("id"),
        CONSTRAINT "FK_flyer_pro_exports_document" FOREIGN KEY ("documentId")
          REFERENCES "flyer_pro_documents"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flyer_pro_exports_document_created" ON "flyer_pro_exports" ("documentId", "createdAt")`,
    );
  }

  /** Apaga o índice e a tabela das exportações; a M1 e a M2 ficam como estavam. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_flyer_pro_exports_document_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "flyer_pro_exports"`);
  }
}
