import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ajuste de entrega da voz por kit (velocidade/expressividade) — coluna
 * jsonb aditiva; kits existentes ficam NULL e usam o perfil global (MC_TTS_*).
 */
export class AddKitVoiceDelivery1765700000000 implements MigrationInterface {
  name = 'AddKitVoiceDelivery1765700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" ADD COLUMN IF NOT EXISTS "voiceDelivery" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mc_character_kits" DROP COLUMN IF EXISTS "voiceDelivery"`,
    );
  }
}
