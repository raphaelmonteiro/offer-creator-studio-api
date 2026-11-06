import { DataSource } from 'typeorm';
import { AddBriefToTemplateScenes1767300000000 } from '../../../migrations/1767300000000-AddBriefToTemplateScenes';
import { TemplateScene } from '../entities/template-scene.entity';
import { insertScene } from '../testing/scene-fixtures';
import { describeIfSceneDb, deleteTestScenes, openSceneTestDb } from '../testing/scene-test-db';
import { applyDirectorRequests, applyJudgeVerdict, openItems, stillMissing } from './scene-brief';
import { DirectorRequest } from './scene-director-schema';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const LATER = new Date('2026-11-07T12:00:00.000Z');
const ctx = (messageId = 'm1', now = NOW, message = 'um rio no meio do campo') => ({
  messageId,
  now,
  message,
});
const open = (text: string, id: string | null = null): DirectorRequest => ({
  id,
  text,
  action: 'open',
  quote: null,
});
const drop = (id: string | null, text: string, quote: string): DirectorRequest => ({
  id,
  text,
  action: 'drop',
  quote,
});

describeIfSceneDb('scene-brief com banco (chroma_x_e2e)', () => {
  let dataSource: DataSource;
  const created: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
  });
  afterAll(async () => {
    await deleteTestScenes(dataSource, created);
    await dataSource.destroy();
  });

  const sceneWithBrief = async () => {
    const scene = await insertScene(dataSource, { name: 'Brief' });
    created.push(scene.id);
    return scene;
  };
  const reload = (id: string) => dataSource.manager.findOneByOrFail(TemplateScene, { id });

  it('a cena nasce com a lista vazia', async () => {
    const scene = await sceneWithBrief();
    expect((await reload(scene.id)).brief).toEqual([]);
  });

  it('O rio não se perde: o pedido fica gravado e volta na leitura seguinte', async () => {
    const scene = await sceneWithBrief();
    const { brief } = applyDirectorRequests([], [open('um campo com um rio no meio')], ctx());
    scene.brief = brief;
    await dataSource.manager.save(scene);

    const loaded = await reload(scene.id);
    expect(openItems(loaded.brief)).toEqual([
      expect.objectContaining({ id: 'p1', text: 'um campo com um rio no meio' }),
    ]);
  });

  it('Continua em aberto: o juiz não viu o rio, e o próximo turno ainda o recebe', async () => {
    const scene = await sceneWithBrief();
    scene.brief = applyDirectorRequests([], [open('rio')], ctx()).brief;
    await dataSource.manager.save(scene);

    const verdict = { seen: [], notSeen: ['p1'] };
    const judged = applyJudgeVerdict((await reload(scene.id)).brief, verdict, LATER);
    scene.brief = judged.brief;
    await dataSource.manager.save(scene);

    const next = await reload(scene.id);
    expect(openItems(next.brief).map((item) => item.id)).toEqual(['p1']);
    expect(stillMissing(next.brief, verdict).map((item) => item.text)).toEqual(['rio']);
  });

  it('Fecha pelo juiz: o item fica feito e o próximo turno não o traz como aberto', async () => {
    const scene = await sceneWithBrief();
    scene.brief = applyDirectorRequests([], [open('rio')], ctx()).brief;
    await dataSource.manager.save(scene);

    scene.brief = applyJudgeVerdict(scene.brief, { seen: ['p1'], notSeen: [] }, LATER).brief;
    await dataSource.manager.save(scene);

    const next = await reload(scene.id);
    expect(next.brief[0].status).toBe('done');
    expect(openItems(next.brief)).toEqual([]);
  });

  it('Cliente desiste: o item fica desistido e some da lista em aberto', async () => {
    const scene = await sceneWithBrief();
    scene.brief = applyDirectorRequests([], [open('rio')], ctx()).brief;
    await dataSource.manager.save(scene);

    scene.brief = applyDirectorRequests(
      scene.brief,
      [drop('p1', 'rio', 'esquece o rio')],
      ctx('m2', LATER),
    ).brief;
    await dataSource.manager.save(scene);

    const next = await reload(scene.id);
    expect(next.brief[0]).toMatchObject({ status: 'dropped', sourceMessageId: 'm2' });
    expect(openItems(next.brief)).toEqual([]);
  });

  it('Voltar outro dia: outra conexão, outro turno, o item de ontem continua aberto', async () => {
    const scene = await sceneWithBrief();
    scene.brief = applyDirectorRequests([], [open('rio')], ctx('m1', NOW)).brief;
    await dataSource.manager.save(scene);

    const otherSession = await openSceneTestDb();
    try {
      const loaded = await otherSession.manager.findOneByOrFail(TemplateScene, { id: scene.id });
      expect(openItems(loaded.brief)).toHaveLength(1);
      const { brief } = applyDirectorRequests(loaded.brief, [open('mais ovos')], ctx('m9', LATER));
      expect(brief.map((item) => item.id)).toEqual(['p1', 'p2']);
    } finally {
      await otherSession.destroy();
    }
  });

  it('migration: down remove a coluna, up recria com o padrão [] e é idempotente', async () => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const migration = new AddBriefToTemplateScenes1767300000000();
      const hasColumn = async () =>
        (await runner.query(
          `SELECT column_default FROM information_schema.columns WHERE table_name = 'template_scenes' AND column_name = 'brief'`,
        )) as Array<{ column_default: string }>;
      await migration.down(runner);
      expect(await hasColumn()).toEqual([]);
      await migration.up(runner);
      await migration.up(runner);
      const [column] = await hasColumn();
      expect(column.column_default).toContain("'[]'");
    } finally {
      await runner.commitTransaction();
      await runner.release();
    }
  });
});
