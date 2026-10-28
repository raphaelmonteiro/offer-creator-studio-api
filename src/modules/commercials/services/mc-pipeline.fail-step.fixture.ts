import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { EmailService } from '../../email/email.service';
import { CommercialsService } from '../commercials.service';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McEvent } from '../entities/mc-event.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';

export type Row = Record<string, unknown> & { id: string };

export const project = (id: string, userId: string): Row => ({
  id,
  userId,
  status: McProjectStatus.GENERATING,
  reservedCredits: 160,
  consumedCredits: 0,
});

export const talk = (id: string, projectId: string, extra: Partial<Row> = {}): Row => ({
  id,
  projectId,
  sceneId: `sc-${id}`,
  sceneGeneration: 1,
  type: McStepType.TALK,
  status: McStepStatus.PROVIDER_WAIT,
  provider: 'fal-ai/kling-video/ai-avatar/v2/standard',
  costCredits: 56,
  attempts: 1,
  providerJobId: 'job',
  ...extra,
});

type EventRow = { refId: string; kind: string; detail: Record<string, unknown> };
type Store = { projects: Row[]; steps: Row[]; events: EventRow[] };
type FakeManager = Record<string, jest.Mock>;

const pick = (store: Store, entity: unknown): Row[] =>
  entity === McProject ? store.projects : entity === McStep ? store.steps : [];

/** Manager de uma transação; o `FOR UPDATE` no projeto serializa as transações (como o Postgres). */
function makeManagerFactory(store: Store) {
  const projectLocks = new Map<string, Promise<void>>();
  return (releases: Array<() => void>): FakeManager => ({
    findOneByOrFail: jest.fn((entity: unknown, where: { id: string }) => {
      if (entity === McScene) {
        return Promise.resolve({ id: where.id, generation: 1, status: McSceneStatus.RUNNING });
      }
      const row = pick(store, entity).find((r) => r.id === where.id);
      return row ? Promise.resolve(row) : Promise.reject(new Error('not found'));
    }),
    findOne: jest.fn(async (entity: unknown, opts: { where: { id: string }; lock?: unknown }) => {
      if (opts.lock) {
        const previous = projectLocks.get(opts.where.id) ?? Promise.resolve();
        let release: () => void = () => undefined;
        projectLocks.set(opts.where.id, new Promise<void>((resolve) => (release = resolve)));
        releases.push(release);
        await previous;
      }
      return pick(store, entity).find((r) => r.id === opts.where.id) ?? null;
    }),
    count: jest.fn((entity: unknown, opts: { where: { refId: string; kind: string } }) => {
      expect(entity).toBe(McEvent);
      return Promise.resolve(
        store.events.filter((e) => e.refId === opts.where.refId && e.kind === opts.where.kind)
          .length,
      );
    }),
    query: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(),
  });
}

function makeDataSource(store: Store, state: { manager: FakeManager }) {
  const makeManager = makeManagerFactory(store);
  state.manager = makeManager([]);
  return {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: (where: { id: string }) =>
        Promise.resolve(pick(store, entity).find((r) => r.id === where.id) ?? null),
    })),
    transaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const tx = makeManager(releases);
      state.manager = tx;
      try {
        return await cb(tx as unknown as EntityManager);
      } finally {
        releases.forEach((release) => release());
      }
    }),
    query: jest.fn().mockResolvedValue([]),
  };
}

/** O CAS do step vence uma única vez por step (a reentrega duplicada perde). */
function makeTransitions(casWins: Set<string>) {
  return {
    casTransition: jest.fn((_m: unknown, entity: unknown, id: string) => {
      if (entity !== McStep) return Promise.resolve(true);
      if (casWins.has(id)) return Promise.resolve(false);
      casWins.add(id);
      return Promise.resolve(true);
    }),
    notify: jest.fn().mockResolvedValue(undefined),
  };
}

/** Banco em memória + fakes do `McPipelineService.failStep` (projetos, steps, eventos, CAS, fila, crédito). */
export function buildFailStepHarness() {
  const store: Store = {
    projects: [project('p1', 'u1'), project('p2', 'u2')],
    steps: [],
    events: [],
  };
  const casWins = new Set<string>();
  const state = { manager: {} as FakeManager };
  const dataSource = makeDataSource(store, state);
  const transitions = makeTransitions(casWins);
  const queue = { publish: jest.fn().mockResolvedValue(undefined) };
  const credits = { refundUnconsumed: jest.fn().mockResolvedValue(0) };
  const commercials = {
    appendEvent: jest.fn((_m: unknown, e: EventRow) => {
      store.events.push({ refId: e.refId, kind: e.kind, detail: e.detail });
      return Promise.resolve();
    }),
  };
  const service = new McPipelineService(
    dataSource as unknown as DataSource,
    transitions as unknown as TaskTransitionService,
    queue as unknown as AnimationQueueService,
    credits as unknown as CreditsService,
    commercials as unknown as CommercialsService,
    { sendCommercialFinished: jest.fn() } as unknown as EmailService,
    { buildPreparationManifest: jest.fn() } as unknown as McMaterializerService,
  );
  const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return { ...store, casWins, transitions, queue, credits, errorLog, service, state };
}
