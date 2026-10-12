import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gate de boca legível e natureza da rodada de candidatos (change
 * video-formatos-personagem, tarefas 2.4 e 2.7):
 *
 * - `mc_character_kits.mouthGate` (jsonb): veredito sobre o logo cru (criação
 *   de kit `logo`), sobre a identidade (antes da aprovação) e o aceite de
 *   risco registrado pelo usuário.
 * - `mc_kit_candidates.kind` (varchar, default `mascotization`): distingue a
 *   rodada de candidatos derivados do logo da rodada de `mouth_variant`
 *   (variante com boca gerada a partir da identidade atual).
 *
 * Aditivo e idempotente (IF NOT EXISTS); kits e candidatos existentes seguem
 * válidos com NULL / default.
 */
export class AddKitMouthGate1766300000000 implements MigrationInterface {
  name = 'AddKitMouthGate1766300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "mouthGate" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "mc_kit_candidates" ADD COLUMN IF NOT EXISTS "kind" varchar(20) NOT NULL DEFAULT 'mascotization'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "mc_kit_candidates" DROP COLUMN IF EXISTS "kind"`);
    await queryRunner.query(`ALTER TABLE "mc_character_kits" DROP COLUMN IF EXISTS "mouthGate"`);
  }
}
