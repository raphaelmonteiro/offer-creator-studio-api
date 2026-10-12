import { getMetadataArgsStorage, QueryRunner } from 'typeorm';
import { AddProjectFormat1766200000000 } from '../../../migrations/1766200000000-AddProjectFormat';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McProject } from './mc-project.entity';

/** Colunas declaradas na entidade McProject, por nome. */
function columnArgs(name: string) {
  const col = getMetadataArgsStorage().columns.find(
    (c) => c.target === McProject && c.propertyName === name,
  );
  if (!col) throw new Error(`coluna ${name} não declarada em McProject`);
  return col.options;
}

/** QueryRunner fake que só grava o SQL emitido (a migration é SQL puro). */
function recordingRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: jest.fn((sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve(undefined);
    }),
  } as unknown as QueryRunner;
  return { runner, queries };
}

const NEW_COLUMNS = [
  'format',
  'tier',
  'channel',
  'backgroundArtAssetId',
  'layoutPreset',
  'logoBox',
  'sourceArt',
];

describe('McProject — formato do projeto (video-formatos-personagem, design D6)', () => {
  it('declara as colunas novas com os mesmos defaults/nulabilidade da migration', () => {
    expect(columnArgs('format')).toMatchObject({ type: 'varchar', length: 20, default: 'scenes' });
    expect(columnArgs('tier')).toMatchObject({ type: 'varchar', length: 10, default: 'economico' });
    expect(columnArgs('channel')).toMatchObject({ type: 'varchar', length: 10, nullable: true });
    expect(columnArgs('backgroundArtAssetId')).toMatchObject({ type: 'uuid', nullable: true });
    expect(columnArgs('layoutPreset')).toMatchObject({
      type: 'varchar',
      length: 40,
      nullable: true,
    });
    expect(columnArgs('logoBox')).toMatchObject({ type: 'jsonb', nullable: true });
    expect(columnArgs('sourceArt')).toMatchObject({ type: 'jsonb', nullable: true });
  });

  it('não mexe em pipelineVersion nem em aspectRatio (executor v2 inalterado)', () => {
    expect(columnArgs('pipelineVersion')).toMatchObject({ type: 'int', default: 1 });
    expect(columnArgs('aspectRatio')).toMatchObject({
      type: 'varchar',
      length: 10,
      default: '9:16',
    });
  });

  it('linha v1/v2 gravada antes da migration lê com os defaults (scenes/economico, resto NULL)', () => {
    // O que o Postgres devolve para um projeto antigo depois de `migration:run`:
    // as colunas NOT NULL vêm preenchidas pelo DEFAULT e as demais vêm NULL.
    const legacyRow = {
      id: 'p-legado',
      userId: 'u1',
      kitId: 'k1',
      title: 'Ofertas',
      status: McProjectStatus.SUCCEEDED,
      pipelineVersion: 1,
      revision: 0,
      quality: null,
      briefing: 'briefing',
      script: null,
      aspectRatio: '9:16' as const,
      targetDurationS: 15,
      options: null,
      format: 'scenes' as const,
      tier: 'economico' as const,
      channel: null,
      backgroundArtAssetId: null,
      layoutPreset: null,
      logoBox: null,
      sourceArt: null,
    };
    const project = Object.assign(new McProject(), legacyRow);
    expect(project.format).toBe('scenes');
    expect(project.tier).toBe('economico');
    expect(project.channel).toBeNull();
    expect(project.backgroundArtAssetId).toBeNull();
    expect(project.layoutPreset).toBeNull();
    expect(project.logoBox).toBeNull();
    expect(project.sourceArt).toBeNull();
    expect(project.pipelineVersion).toBe(1);
    expect(project.aspectRatio).toBe('9:16');

    const v2Row = { ...legacyRow, id: 'p-v2', pipelineVersion: 2, quality: {} };
    const v2 = Object.assign(new McProject(), v2Row);
    expect(v2.format).toBe('scenes');
    expect(v2.pipelineVersion).toBe(2);
  });
});

describe('AddProjectFormat1766200000000 — migration aditiva e idempotente', () => {
  it('up: 7 ADD COLUMN IF NOT EXISTS em mc_projects, com defaults de format/tier', async () => {
    const { runner, queries } = recordingRunner();
    await new AddProjectFormat1766200000000().up(runner);
    expect(queries).toHaveLength(NEW_COLUMNS.length);
    for (const sql of queries) {
      expect(sql).toMatch(/^ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "/);
    }
    expect(queries).toContain(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "format" varchar(20) NOT NULL DEFAULT 'scenes'`,
    );
    expect(queries).toContain(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "tier" varchar(10) NOT NULL DEFAULT 'economico'`,
    );
    expect(queries).toContain(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "channel" varchar(10)`,
    );
    expect(queries).toContain(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "backgroundArtAssetId" uuid`,
    );
    expect(queries).toContain(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "layoutPreset" varchar(40)`,
    );
    expect(queries).toContain(`ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "logoBox" jsonb`);
    expect(queries).toContain(
      `ALTER TABLE "mc_projects" ADD COLUMN IF NOT EXISTS "sourceArt" jsonb`,
    );
  });

  it('não toca pipelineVersion nem outras tabelas', async () => {
    const { runner, queries } = recordingRunner();
    await new AddProjectFormat1766200000000().up(runner);
    await new AddProjectFormat1766200000000().down(runner);
    expect(queries.some((q) => q.includes('pipelineVersion'))).toBe(false);
    expect(queries.every((q) => q.includes('"mc_projects"'))).toBe(true);
  });

  it('down: DROP COLUMN IF EXISTS de cada coluna nova (ordem inversa)', async () => {
    const { runner, queries } = recordingRunner();
    await new AddProjectFormat1766200000000().down(runner);
    expect(queries).toEqual(
      [...NEW_COLUMNS]
        .reverse()
        .map((col) => `ALTER TABLE "mc_projects" DROP COLUMN IF EXISTS "${col}"`),
    );
  });
});
