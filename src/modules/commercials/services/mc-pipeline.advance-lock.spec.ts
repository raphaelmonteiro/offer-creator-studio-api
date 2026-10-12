import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { EmailService } from '../../email/email.service';
import { CommercialsService } from '../commercials.service';
import { MC_PIPELINE_V2, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';

type Row = Record<string, unknown> & { id: string };
type Table = 'steps' | 'scenes';

/**
 * Corrida de "lost wakeup" no avanço do scheduler (e2e mock combos, 12/10/2026):
 * os DOIS últimos `talk` de um projeto concluídos em transações concorrentes
 * (mc.ingest com concorrência 2) liam, cada um, a cena do outro ainda não
 * commitada; nenhum via "todas as cenas prontas" e o step de projeto ficava
 * `pending` para sempre (projeto parado em `generating`). `enqueueReadySteps`
 * agora trava a linha do projeto (`FOR UPDATE`) antes de ler: a segunda
 * conclusão espera o commit da primeira e enxerga a cena dela.
 *
 * Banco simulado: estado commitado + escrita própria de cada transação
 * (READ COMMITTED), `FOR UPDATE` como mutex por projeto liberado no commit, e
 * cada leitura cede o event loop (as duas transações se intercalam de verdade).
 */
class FakeDb {
  readonly steps = new Map<string, Row>();
  readonly scenes = new Map<string, Row>();
  private tail: Promise<void> = Promise.resolve();

  /** Mutex FIFO da linha do projeto: resolve com a função que o libera (no commit). */
  lock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const wait = this.tail;
    this.tail = this.tail.then(() => held);
    return wait.then(() => release);
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function openTx(db: FakeDb, project: Row, transactional: boolean) {
  const own: Record<Table, Map<string, Row>> = { steps: new Map(), scenes: new Map() };
  let release: (() => void) | null = null;
  const current = (table: Table, id: string) => own[table].get(id) ?? db[table].get(id);
  const view = (table: Table) =>
    [...db[table].values()].map((row) => own[table].get(row.id) ?? row);
  const write = (table: Table, id: string, patch: Partial<Row>) => {
    own[table].set(id, { ...(current(table, id) as Row), ...patch });
  };
  const manager = {
    queryRunner: transactional ? { isTransactionActive: true } : undefined,
    query: jest.fn(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) release = await db.lock();
      return [];
    }),
    findOneByOrFail: jest.fn(async () => {
      await tick();
      return project;
    }),
    find: jest.fn(async (entity: unknown) => {
      await tick();
      if (entity === McScene) return view('scenes');
      if (entity === McStep) return view('steps');
      return [];
    }),
    /** CAS da linha na transação (o TaskTransitionService mockado delega para cá). */
    cas(entity: unknown, id: string, from: string, to: string): boolean {
      if (entity === McProject) return true;
      const table: Table = entity === McScene ? 'scenes' : 'steps';
      if (current(table, id)?.status !== from) return false;
      write(table, id, { status: to });
      return true;
    },
  };
  return {
    manager,
    write,
    commit() {
      for (const table of ['steps', 'scenes'] as Table[]) {
        for (const [id, row] of own[table]) db[table].set(id, row);
      }
      release?.();
    },
  };
}

describe('McPipelineService.enqueueReadySteps — avanço serializado por projeto', () => {
  let db: FakeDb;
  let project: Row;
  let queue: { publish: jest.Mock };
  let service: McPipelineService;

  beforeEach(() => {
    db = new FakeDb();
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'k1',
      status: McProjectStatus.GENERATING,
      pipelineVersion: MC_PIPELINE_V2,
      format: 'talking_art',
      revision: 0,
      quality: resolveQuality({
        approval: {
          scope: 'production',
          revision: 0,
          manifestHash: 'h',
          approvedAt: 'now',
          userId: 'u1',
          budgetCredits: 0,
        },
      }),
    };
    for (const [idx, id] of ['sc1', 'sc2'].entries()) {
      db.scenes.set(id, {
        id,
        projectId: 'p1',
        idx,
        generation: 1,
        status: McSceneStatus.RUNNING,
        sceneType: 'talk_tile',
        scriptSceneId: `s${idx + 1}`,
      });
      for (const [type, status, phase] of [
        [McStepType.TTS, McStepStatus.SUCCEEDED, 'preparation'],
        [McStepType.TALK, McStepStatus.INGESTING, 'production'],
      ] as const) {
        const stepId = `st-${type}-${id}`;
        db.steps.set(stepId, {
          id: stepId,
          projectId: 'p1',
          sceneId: id,
          sceneGeneration: 1,
          projectRevision: 0,
          phase,
          attempt: 1,
          type,
          status,
        });
      }
    }
    for (const type of [McStepType.COMPOSE_FFMPEG, McStepType.FINALIZE]) {
      db.steps.set(`st-${type}`, {
        id: `st-${type}`,
        projectId: 'p1',
        sceneId: null,
        sceneGeneration: null,
        projectRevision: 0,
        phase: 'assembly',
        attempt: 1,
        type,
        status: McStepStatus.PENDING,
      });
    }
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    const transitions = {
      casTransition: jest.fn(
        async (manager: { cas: (...a: unknown[]) => boolean }, entity, id, from, to) =>
          manager.cas(entity, id, from, to),
      ),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    service = new McPipelineService(
      {} as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      { refundUnconsumed: jest.fn() } as unknown as CreditsService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      { sendCommercialFinished: jest.fn() } as unknown as EmailService,
      {} as unknown as McMaterializerService,
    );
  });

  /** O que `completeStepAndAdvance` faz: talk → succeeded, cena → ready, avanço, commit. */
  async function completeLastTalk(tx: ReturnType<typeof openTx>, sceneId: string) {
    tx.write('steps', `st-${McStepType.TALK}-${sceneId}`, { status: McStepStatus.SUCCEEDED });
    tx.write('scenes', sceneId, { status: McSceneStatus.READY, finalAssetId: `clip-${sceneId}` });
    const enqueued = await service.enqueueReadySteps(tx.manager as unknown as EntityManager, 'p1');
    // o resto da transação (eventos, notify, preparação) e a ida e volta do COMMIT
    for (let i = 0; i < 3; i += 1) await tick();
    tx.commit();
    return enqueued;
  }

  it('trava a linha do projeto (FOR UPDATE) ANTES de ler projeto, cenas e steps', async () => {
    const tx = openTx(db, project, true);
    await service.enqueueReadySteps(tx.manager as unknown as EntityManager, 'p1');
    expect(tx.manager.query).toHaveBeenCalledWith(
      'SELECT "id" FROM "mc_projects" WHERE "id" = $1 FOR UPDATE',
      ['p1'],
    );
    const lockAt = tx.manager.query.mock.invocationCallOrder[0];
    expect(lockAt).toBeLessThan(tx.manager.findOneByOrFail.mock.invocationCallOrder[0]);
    expect(lockAt).toBeLessThan(tx.manager.find.mock.invocationCallOrder[0]);
    tx.commit();
  });

  it('sem transação ativa não trava (comportamento anterior preservado)', async () => {
    const tx = openTx(db, project, false);
    await service.enqueueReadySteps(tx.manager as unknown as EntityManager, 'p1');
    expect(tx.manager.query).not.toHaveBeenCalled();
  });

  it('dois últimos talk concorrentes: a composição é enfileirada UMA vez', async () => {
    const [a, b] = await Promise.all([
      completeLastTalk(openTx(db, project, true), 'sc1'),
      completeLastTalk(openTx(db, project, true), 'sc2'),
    ]);
    expect([...a, ...b]).toEqual([`st-${McStepType.COMPOSE_FFMPEG}`]);
    expect(db.steps.get(`st-${McStepType.COMPOSE_FFMPEG}`)?.status).toBe(McStepStatus.QUEUED);
    expect(db.steps.get(`st-${McStepType.FINALIZE}`)?.status).toBe(McStepStatus.PENDING);
    expect(queue.publish).toHaveBeenCalledTimes(1);
  });

  it('a mesma intercalação SEM a trava perde o avanço (a corrida que o FOR UPDATE fecha)', async () => {
    const [a, b] = await Promise.all([
      completeLastTalk(openTx(db, project, false), 'sc1'),
      completeLastTalk(openTx(db, project, false), 'sc2'),
    ]);
    expect([...a, ...b]).toEqual([]);
    expect(db.steps.get(`st-${McStepType.COMPOSE_FFMPEG}`)?.status).toBe(McStepStatus.PENDING);
    expect(queue.publish).not.toHaveBeenCalled();
  });
});
