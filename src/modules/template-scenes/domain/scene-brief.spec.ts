import { DataSource } from 'typeorm';
import { AddBriefToTemplateScenes1767300000000 } from '../../../migrations/1767300000000-AddBriefToTemplateScenes';
import { TemplateScene } from '../entities/template-scene.entity';
import { insertScene } from '../testing/scene-fixtures';
import { describeIfSceneDb, deleteTestScenes, openSceneTestDb } from '../testing/scene-test-db';
import {
  applyDirectorRequests,
  applyJudgeVerdict,
  BriefItem,
  openItems,
  stillMissing,
} from './scene-brief';
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

const RIO: BriefItem = {
  id: 'p1',
  text: 'um rio no meio do campo',
  status: 'open',
  sourceMessageId: 'm1',
  updatedAt: NOW.toISOString(),
};

describe('scene-brief', () => {
  describe('abrir', () => {
    it('pedido novo vira item aberto com id curto, mensagem de origem e data', () => {
      const { brief, changes } = applyDirectorRequests([], [open('um rio no meio')], ctx());
      expect(brief).toEqual([
        {
          id: 'p1',
          text: 'um rio no meio',
          status: 'open',
          sourceMessageId: 'm1',
          updatedAt: NOW.toISOString(),
        },
      ]);
      expect(changes).toEqual({ opened: ['p1'], dropped: [], closed: [], reopened: [] });
    });

    it('Pedido com ano não fica em aberto: ano, data e número escrito não abrem item, e "tira o 2027" abre', () => {
      const { brief, changes } = applyDirectorRequests(
        [],
        [open('indicação do ano 2027'), open('a data 12/04'), open('tira o 2027 do ovo')],
        ctx(),
      );
      expect(brief.map((item) => item.text)).toEqual(['tira o 2027 do ovo']);
      expect(changes.opened).toEqual(['p1']);
    });

    it('R8: "rio" não casa com "cenário colorido": vira item novo, e o outro não muda', () => {
      const colorido: BriefItem = { ...RIO, id: 'p1', text: 'cenário colorido' };
      const { brief, changes } = applyDirectorRequests([colorido], [open('rio')], ctx());
      expect(brief.map((item) => [item.id, item.text, item.status])).toEqual([
        ['p1', 'cenário colorido', 'open'],
        ['p2', 'rio', 'open'],
      ]);
      expect(changes.opened).toEqual(['p2']);
    });

    it.each([
      ['sol', 'girassol amarelo'],
      ['flor', 'campo florido'],
    ])('R8: "%s" não casa com "%s"', (wanted, existing) => {
      const item: BriefItem = { ...RIO, text: existing };
      const { brief } = applyDirectorRequests([item], [open(wanted)], ctx());
      expect(brief).toHaveLength(2);
    });

    it('R8: palavra inteira casa, inclusive no plural ("rio" em "um rio largo", "coelhos" em "coelho")', () => {
      const item: BriefItem = { ...RIO, text: 'um rio largo' };
      expect(applyDirectorRequests([item], [open('rio')], ctx()).brief).toHaveLength(1);
      const coelho: BriefItem = { ...RIO, text: 'coelho' };
      expect(applyDirectorRequests([coelho], [open('coelhos')], ctx()).brief).toHaveLength(1);
    });

    it('os ids seguem a sequência, mesmo depois de itens feitos ou desistidos', () => {
      const done: BriefItem = { ...RIO, id: 'p3', status: 'done' };
      const { brief } = applyDirectorRequests([done], [open('mais ovos')], ctx('m2'));
      expect(brief.map((item) => item.id)).toEqual(['p3', 'p4']);
    });

    it('pedido repetido, com o mesmo texto, não duplica', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [open('Um RIO no meio do campo')],
        ctx('m2'),
      );
      expect(brief).toHaveLength(1);
      expect(changes.opened).toEqual([]);
    });

    it('cliente pede de novo um item feito ou desistido: reabre', () => {
      const done: BriefItem = { ...RIO, status: 'done' };
      const result = applyDirectorRequests([done], [open('rio', 'p1')], ctx('m2', LATER));
      expect(result.brief[0]).toMatchObject({
        status: 'open',
        sourceMessageId: 'm2',
        updatedAt: LATER.toISOString(),
      });
      expect(result.changes.reopened).toEqual(['p1']);
    });

    it('não altera a lista recebida', () => {
      const original = [RIO];
      applyDirectorRequests(original, [drop('p1', 'rio', 'esquece o rio')], ctx('m2'));
      expect(original[0].status).toBe('open');
    });
  });

  describe('reabrir (R10)', () => {
    const feito: BriefItem = { ...RIO, id: 'p1', text: 'coelho', status: 'done' };

    it('o Diretor não reabre item feito se a mensagem atual não fala dele', () => {
      const { brief, changes } = applyDirectorRequests(
        [feito],
        [open('coelho')],
        ctx('m2', NOW, 'deixa mais quente'),
      );
      expect(brief[0].status).toBe('done');
      expect(changes.reopened).toEqual([]);
    });

    it('o cliente pede de novo na mensagem atual: o item volta a aberto', () => {
      const { brief, changes } = applyDirectorRequests(
        [feito],
        [open('coelho')],
        ctx('m2', NOW, 'coloca outro coelho'),
      );
      expect(brief[0].status).toBe('open');
      expect(changes.reopened).toEqual(['p1']);
    });

    it('item desistido também só reabre se a mensagem atual fala dele', () => {
      const desistido: BriefItem = { ...feito, status: 'dropped' };
      expect(
        applyDirectorRequests([desistido], [open('coelho')], ctx('m2', NOW, 'mais flores')).brief[0]
          .status,
      ).toBe('dropped');
    });
  });

  describe('desistir', () => {
    it('drop por id', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [drop('p1', 'rio', 'esquece o rio')],
        ctx('m2'),
      );
      expect(brief[0].status).toBe('dropped');
      expect(changes.dropped).toEqual(['p1']);
    });

    it('drop sem id acha o item pelo texto contido', () => {
      const { brief } = applyDirectorRequests(
        [RIO],
        [drop(null, 'rio', 'esquece o rio')],
        ctx('m2'),
      );
      expect(brief[0].status).toBe('dropped');
    });

    it('R8: "esquece o rio" desiste do "um rio largo", e não do "cenário colorido"', () => {
      const colorido: BriefItem = { ...RIO, id: 'p1', text: 'cenário colorido' };
      const largo: BriefItem = { ...RIO, id: 'p2', text: 'um rio largo' };
      const { brief, changes } = applyDirectorRequests(
        [colorido, largo],
        [drop(null, 'rio', 'esquece o rio')],
        ctx('m2', NOW, 'esquece o rio'),
      );
      expect(brief.map((item) => [item.id, item.status])).toEqual([
        ['p1', 'open'],
        ['p2', 'dropped'],
      ]);
      expect(changes.dropped).toEqual(['p2']);
    });

    it('drop de item que não existe é ignorado', () => {
      const { brief, changes } = applyDirectorRequests(
        [RIO],
        [drop(null, 'borboleta', 'sem borboleta')],
        ctx('m2'),
      );
      expect(brief).toEqual([RIO]);
      expect(changes.dropped).toEqual([]);
    });
  });

  describe('juiz', () => {
    it('só o juiz fecha: item visto vira feito, e o que ele não viu continua aberto', () => {
      const second: BriefItem = { ...RIO, id: 'p2', text: 'ovos no rodapé' };
      const { brief, changes } = applyJudgeVerdict(
        [RIO, second],
        { seen: ['p1'], notSeen: ['p2'] },
        LATER,
      );
      expect(brief.map((item) => item.status)).toEqual(['done', 'open']);
      expect(changes.closed).toEqual(['p1']);
      expect(openItems(brief).map((item) => item.id)).toEqual(['p2']);
      expect(
        stillMissing(brief, { seen: ['p1'], notSeen: ['p2'] }).map((item) => item.text),
      ).toEqual(['ovos no rodapé']);
    });

    it('item feito que o juiz não vê mais depois de um redesenho reabre', () => {
      const done: BriefItem = { ...RIO, status: 'done' };
      const { brief, changes } = applyJudgeVerdict([done], { seen: [], notSeen: ['p1'] }, LATER);
      expect(brief[0].status).toBe('open');
      expect(changes.reopened).toEqual(['p1']);
    });

    it('ids desconhecidos e itens desistidos não mudam', () => {
      const dropped: BriefItem = { ...RIO, status: 'dropped' };
      const { brief } = applyJudgeVerdict(
        [dropped],
        { seen: ['p1', 'p9'], notSeen: ['p1'] },
        LATER,
      );
      expect(brief).toEqual([dropped]);
    });
  });
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
