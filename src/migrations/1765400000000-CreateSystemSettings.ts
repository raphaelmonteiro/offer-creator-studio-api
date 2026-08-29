import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tabela key/value de configuração operacional em banco (plano-comerciais
 * §6.7 e Fase 0 do §10): heartbeat do worker (lido pelo /v1/health e pelo
 * gate do deploy.sh) e kill-switch 'mc_paused' checado no enqueue de
 * comerciais. Em prod (synchronize off) rodar via migration:run; em dev o
 * synchronize cria o mesmo schema a partir da entity SystemSetting.
 */
export class CreateSystemSettings1765400000000 implements MigrationInterface {
  name = 'CreateSystemSettings1765400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "system_settings" (
        "key" text PRIMARY KEY,
        "value" jsonb NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "system_settings"`);
  }
}
