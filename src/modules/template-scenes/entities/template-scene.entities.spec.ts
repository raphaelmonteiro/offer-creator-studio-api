import * as fs from 'fs';
import * as path from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { TemplateScene } from './template-scene.entity';
import { TemplateSceneAsset } from './template-scene-asset.entity';
import { TemplateSceneFace } from './template-scene-face.entity';
import { TemplateSceneMessage } from './template-scene-message.entity';
import { TemplateSceneVersion } from './template-scene-version.entity';

/**
 * Os nomes de índice e de FK da entidade precisam ser os da migration: com `synchronize` ligado
 * em development, qualquer diferença faz o TypeORM recriar o índice no boot (achado 7).
 */
const migrationFile = (name: string) =>
  fs.readFileSync(path.join(__dirname, '../../../migrations', name), 'utf8');
/** A criação das tabelas e a das faces (change add-template-scene-faces): juntas, o que as entidades declaram. */
const MIGRATION =
  migrationFile('1767200000000-CreateTemplateScenes.ts') +
  migrationFile('1767400000000-AddTemplateSceneFaces.ts');
const ENTITIES = [
  TemplateScene,
  TemplateSceneFace,
  TemplateSceneVersion,
  TemplateSceneAsset,
  TemplateSceneMessage,
];

describe('entidades da cena x migrations 1767200000000 e 1767400000000', () => {
  const storage = getMetadataArgsStorage();

  it('todo índice tem nome explícito, presente na migration', () => {
    const indices = storage.indices.filter((index) => ENTITIES.includes(index.target as never));
    expect(indices.map((index) => index.name).sort()).toEqual(
      [
        'IDX_template_scenes_deleted_updated',
        'IDX_tsa_expires',
        'IDX_tsa_scene',
        'IDX_tsm_scene_created',
        'IDX_tsv_scene_face_status',
        'IDX_tsv_scene_status',
        'UQ_tsf_scene_index',
        'UQ_tsf_scene_key',
        'UQ_tsv_scene_busy',
        'UQ_tsv_scene_number',
      ].sort(),
    );
    for (const index of indices) expect(MIGRATION).toContain(`"${index.name}"`);
  });

  it('o índice de cena ocupada é único e parcial (queued/running)', () => {
    const busy = storage.indices.find((index) => index.name === 'UQ_tsv_scene_busy');
    expect(busy?.unique).toBe(true);
    expect(busy?.where).toContain(`'queued', 'running'`);
    expect(MIGRATION).toContain(`WHERE "status" IN ('queued', 'running')`);
  });

  it('toda FK tem nome explícito, presente na migration', () => {
    const joins = storage.joinColumns.filter((join) => ENTITIES.includes(join.target as never));
    expect(joins.length).toBe(4);
    for (const join of joins) {
      expect(join.foreignKeyConstraintName).toBeDefined();
      expect(MIGRATION).toContain(`"${join.foreignKeyConstraintName}"`);
    }
  });

  it('toda chave primária tem nome explícito, presente na migration', () => {
    const generated = storage.generations.filter((g) => ENTITIES.includes(g.target as never));
    expect(generated).toHaveLength(5);
    for (const name of [
      'PK_template_scenes',
      'PK_template_scene_versions',
      'PK_template_scene_assets',
      'PK_template_scene_messages',
      'PK_template_scene_faces',
    ]) {
      expect(MIGRATION).toContain(`"${name}"`);
    }
  });
});
