import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Peça de ofertas configurável (change video-peca-configuravel, grupo 4):
 *
 * - `mc_pieces`: a peça que o cliente monta no editor (e o modelo salvo,
 *   `kind = 'template'`), com o descritor em jsonb (frações do quadro), o
 *   formato, o cliente e a revisão (lock otimista do autosave).
 * - `mc_projects.pieceId` / `pieceSnapshot`: o projeto `offer_piece` aponta
 *   para a peça e guarda a cópia imutável do descritor no momento de gerar
 *   (o `script` continua a fonte das falas; a peça é a fonte do quadro).
 *
 * Aditivo e idempotente (IF NOT EXISTS). `pieceId` sem FK física: o service
 * recusa apagar uma peça com projeto em andamento (422 PIECE_IN_USE) e um
 * projeto terminado continua reproduzível pelo snapshot.
 */
export class CreateMcPieces1767000000000 implements MigrationInterface {
  name = 'CreateMcPieces1767000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "mc_pieces" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "clientId" uuid,
        "kind" varchar(10) NOT NULL DEFAULT 'piece',
        "name" varchar(120) NOT NULL,
        "aspectRatio" varchar(10) NOT NULL DEFAULT '9:16',
        "document" jsonb NOT NULL,
        "revision" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mc_pieces" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_mc_pieces_kind" CHECK ("kind" IN ('piece', 'template'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_pieces_user_kind_updated" ON "mc_pieces" ("userId", "kind", "updatedAt")`,
    );
    await queryRunner.query(`ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "pieceId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "pieceSnapshot" jsonb`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mc_projects_piece" ON "mc_projects" ("pieceId") WHERE "pieceId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mc_projects_piece"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "pieceSnapshot"`);
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "pieceId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mc_pieces_user_kind_updated"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mc_pieces"`);
  }
}
