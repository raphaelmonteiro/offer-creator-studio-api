import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zonas por versão (change add-template-scene-tabloid, PV-T10): `template_scene_versions.zones` (jsonb, nulo).
 *
 * Nulo = as zonas da face na criação; nenhuma linha atual muda. A altura do cabeçalho do jornal vale para a imagem em
 * que foi pintada: a versão grava `zones` quando difere da criação, e "voltar" traz a altura junto. Aditiva e
 * idempotente. `layout` e `key` são `varchar(16)` sem `CHECK`, então `tabloid`, `outer` e `inner` não pedem schema.
 * `down` apaga a coluna: a altura do cabeçalho de versões antigas se perde (as faces já têm as zonas em vigor).
 */
export class AddTemplateSceneVersionZones1767500000000 implements MigrationInterface {
  name = 'AddTemplateSceneVersionZones1767500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "template_scene_versions" ADD COLUMN IF NOT EXISTS "zones" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "template_scene_versions" DROP COLUMN IF EXISTS "zones"`);
  }
}
