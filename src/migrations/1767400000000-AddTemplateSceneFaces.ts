import { MigrationInterface, QueryRunner } from 'typeorm';
import { sceneZonesFor } from '../modules/template-scenes/domain/scene-formats';

/**
 * Faces da cena (change add-template-scene-faces, D-1):
 *
 * - `template_scenes.layout` (`single` | `front_back`, padrão `single`);
 * - tabela `template_scene_faces` (uma linha por face: zonas, tamanho, versão atual e template);
 * - `template_scene_versions.faceIndex` e `derivedFromVersionId`;
 * - `template_scene_messages.faceIndex`.
 *
 * Backfill: cada cena existente (inclusive as excluídas) vira uma cena de uma face, com a versão atual e o template
 * que ela já tinha; versões e mensagens ficam na face 0 pelo padrão da coluna. `template_scenes.currentVersionId` e
 * `approvedTemplateId` continuam valendo e passam a espelhar a face 0. Aditiva e idempotente; os nomes de índice e de
 * FK são os das entidades, para o `synchronize` do desenvolvimento não ver diferença. Zonas pela mesma função pura do
 * código (`sceneZonesFor`, que é `faceZones` da face única, PV-3); formato desconhecido (removido da lista) recebe o
 * miolo inteiro.
 * `down` apaga a tabela e as colunas: cenas de frente e verso criadas depois perdem o verso.
 */
export class AddTemplateSceneFaces1767400000000 implements MigrationInterface {
  name = 'AddTemplateSceneFaces1767400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "template_scenes" ADD COLUMN IF NOT EXISTS "layout" varchar(16) NOT NULL DEFAULT 'single'`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "template_scene_faces" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sceneId" uuid NOT NULL,
        "index" smallint NOT NULL,
        "key" varchar(16) NOT NULL,
        "label" varchar(40),
        "zones" jsonb NOT NULL,
        "widthPx" integer NOT NULL,
        "heightPx" integer NOT NULL,
        "currentVersionId" uuid,
        "templateId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_template_scene_faces" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tsf_scene" FOREIGN KEY ("sceneId") REFERENCES "template_scenes"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tsf_scene_index" ON "template_scene_faces" ("sceneId", "index")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tsf_scene_key" ON "template_scene_faces" ("sceneId", "key")`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_scene_versions" ADD COLUMN IF NOT EXISTS "faceIndex" smallint NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_scene_versions" ADD COLUMN IF NOT EXISTS "derivedFromVersionId" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tsv_scene_face_status" ON "template_scene_versions" ("sceneId", "faceIndex", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_scene_messages" ADD COLUMN IF NOT EXISTS "faceIndex" smallint NOT NULL DEFAULT 0`,
    );
    await this.backfill(queryRunner);
  }

  /** Uma face `single` por cena que ainda não tem face: repetir a migration não duplica nem sobrescreve. */
  private async backfill(queryRunner: QueryRunner): Promise<void> {
    const scenes: Array<{ id: string; formatId: string }> = await queryRunner.query(
      `SELECT s."id", s."formatId" FROM "template_scenes" s
        WHERE NOT EXISTS (SELECT 1 FROM "template_scene_faces" f WHERE f."sceneId" = s."id")`,
    );
    const byFormat = new Map<string, string>();
    for (const scene of scenes) {
      if (!byFormat.has(scene.formatId)) {
        byFormat.set(scene.formatId, JSON.stringify(sceneZonesFor(scene.formatId)));
      }
    }
    for (const [formatId, zones] of byFormat) {
      await queryRunner.query(
        `INSERT INTO "template_scene_faces"
           ("sceneId", "index", "key", "label", "zones", "widthPx", "heightPx", "currentVersionId", "templateId")
         SELECT s."id", 0, 'single', NULL, $2::jsonb, s."widthPx", s."heightPx", s."currentVersionId", s."approvedTemplateId"
           FROM "template_scenes" s
          WHERE s."formatId" = $1
            AND NOT EXISTS (SELECT 1 FROM "template_scene_faces" f WHERE f."sceneId" = s."id")`,
        [formatId, zones],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "template_scene_faces"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tsv_scene_face_status"`);
    await queryRunner.query(
      `ALTER TABLE "template_scene_messages" DROP COLUMN IF EXISTS "faceIndex"`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_scene_versions" DROP COLUMN IF EXISTS "derivedFromVersionId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_scene_versions" DROP COLUMN IF EXISTS "faceIndex"`,
    );
    await queryRunner.query(`ALTER TABLE "template_scenes" DROP COLUMN IF EXISTS "layout"`);
  }
}
