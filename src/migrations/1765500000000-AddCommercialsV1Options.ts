import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1-B1 (multi-cena) — migration ADITIVA sobre o schema do
 * 1765300000000-CreateCommercialsModule.
 *
 * Única mudança de schema do bloco: `mc_projects.options` (jsonb, nullable),
 * que guarda as preferências de montagem do contrato v1
 * (`musicEnabled`, `captionsEnabled`, `products[{name, price}]`).
 *
 * Por que jsonb e não 3 colunas: o conjunto é um bloco de opções do MESMO
 * domínio (montagem), tende a crescer (SFX, marca d'água) e nada nele é chave
 * de busca, ordenação ou hash — `aspectRatio`/`targetDurationS` seguem como
 * colunas próprias justamente por serem. NULL = projeto anterior ao bloco;
 * `resolveProjectOptions` (domain/mc-types) aplica os defaults em memória, sem
 * backfill.
 *
 * O resto do contrato v1 (roteiro v2 com `actionPromptEn`/`seal.products`/
 * `endcard`, alinhamento do TTS nos assets) vive em jsonb JÁ EXISTENTE
 * (`mc_projects.script`, `animation_assets.metadata`) — nada a migrar.
 *
 * Em prod (synchronize off) rodar com `npm run migration:run`; em dev o
 * synchronize cria a mesma coluna a partir da entidade.
 */
export class AddCommercialsV1Options1765500000000 implements MigrationInterface {
  name = 'AddCommercialsV1Options1765500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "options" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "options"`);
  }
}
