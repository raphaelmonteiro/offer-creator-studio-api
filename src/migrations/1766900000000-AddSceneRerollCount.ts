import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `mc_scenes.rerollCount` (plano-comerciais §8): nº de re-rolls pedidos pelo
 * usuário por cena (o 1º é grátis; do 2º em diante há mini-reserva). A coluna
 * entrou na entidade em `aa0f1cd` com a nota "coluna nova via SQL manual" e o
 * SQL nunca rodou em produção: com `synchronize` desligado, TODO `SELECT` de
 * cenas (`GET /commercials/projects/:id`, scheduler, montagem) caía com
 * "column McScene.rerollCount does not exist".
 *
 * Aditivo e idempotente (IF NOT EXISTS); cenas existentes ficam com 0.
 */
export class AddSceneRerollCount1766900000000 implements MigrationInterface {
  name = 'AddSceneRerollCount1766900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_scenes" ADD COLUMN IF NOT EXISTS "rerollCount" int NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mc_scenes" DROP COLUMN IF EXISTS "rerollCount"`);
  }
}
