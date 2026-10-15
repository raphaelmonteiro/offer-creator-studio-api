import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Custo de fornecedor do kit do personagem (change video-formatos-personagem,
 * tarefa 2.6 — "geração real de kit com custo registrado"):
 *
 * - `mc_character_kits.providerCostUsd` (numeric(12,6), default 0): soma das
 *   chamadas pagas do kit (descrição canônica, referências, gate de boca,
 *   candidatos, variante com boca e traduções), incrementada a cada chamada.
 *   Cada chamada fica também como evento `provider_cost` em `mc_events`.
 *   Seis casas porque uma tradução no gpt-4o-mini custa frações de centésimo
 *   de centavo e somaria zero em quatro.
 *
 * Aditivo e idempotente (IF NOT EXISTS); kits existentes ficam com 0
 * (custo anterior não registrado).
 */
export class AddKitProviderCost1766400000000 implements MigrationInterface {
  name = 'AddKitProviderCost1766400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "providerCostUsd" numeric(12,6) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" DROP COLUMN IF EXISTS "providerCostUsd"`,
    );
  }
}
