import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
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

type Row = Record<string, unknown> & { id: string };

/** Alerta de crédito/chave do fornecedor: um por projeto, log ADMIN_ALERT, sem pausar o módulo (Q2, Q3). */
describe('McPipelineService.failStep — admin_alert de quota', () => {
  const projects: Row[] = [];
  const steps: Row[] = [];
  const events: Array<{ refId: string; kind: string; detail: Record<string, unknown> }> = [];
  let casWins: Set<string>;
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let credits: { refundUnconsumed: jest.Mock };
  let manager: Record<string, jest.Mock>;
  let errorLog: jest.SpyInstance;
  let service: McPipelineService;

  const project = (id: string, userId: string): Row => ({
    id,
    userId,
    status: McProjectStatus.GENERATING,
    reservedCredits: 160,
    consumedCredits: 0,
  });
  const talk = (id: string, projectId: string, extra: Partial<Row> = {}): Row => ({
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

  beforeEach(() => {
    projects.splice(0, projects.length, project('p1', 'u1'), project('p2', 'u2'));
    steps.splice(0, steps.length);
    events.length = 0;
    casWins = new Set();
    const pick = (entity: unknown): Row[] =>
      entity === McProject ? projects : entity === McStep ? steps : [];
    // Cada transação tem o seu manager; `FOR UPDATE` no projeto serializa as transações (como o Postgres).
    const projectLocks = new Map<string, Promise<void>>();
    const makeManager = (releases: Array<() => void>) => ({
      findOneByOrFail: jest.fn((entity: unknown, where: { id: string }) => {
        if (entity === McScene) {
          return Promise.resolve({ id: where.id, generation: 1, status: McSceneStatus.RUNNING });
        }
        const row = pick(entity).find((r) => r.id === where.id);
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
        return pick(entity).find((r) => r.id === opts.where.id) ?? null;
      }),
      count: jest.fn((entity: unknown, opts: { where: { refId: string; kind: string } }) => {
        expect(entity).toBe(McEvent);
        return Promise.resolve(
          events.filter((e) => e.refId === opts.where.refId && e.kind === opts.where.kind).length,
        );
      }),
      query: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    });
    manager = makeManager([]);
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: (where: { id: string }) =>
          Promise.resolve(pick(entity).find((r) => r.id === where.id) ?? null),
      })),
      transaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => {
        const releases: Array<() => void> = [];
        const tx = makeManager(releases);
        manager = tx;
        try {
          return await cb(tx as unknown as EntityManager);
        } finally {
          releases.forEach((release) => release());
        }
      }),
      query: jest.fn().mockResolvedValue([]),
    };
    // o CAS do step vence uma única vez por step (a reentrega duplicada perde)
    transitions = {
      casTransition: jest.fn((_m: unknown, entity: unknown, id: string) => {
        if (entity !== McStep) return Promise.resolve(true);
        if (casWins.has(id)) return Promise.resolve(false);
        casWins.add(id);
        return Promise.resolve(true);
      }),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    credits = { refundUnconsumed: jest.fn().mockResolvedValue(0) };
    const commercials = {
      appendEvent: jest.fn((_m: unknown, e: { refId: string; kind: string; detail: never }) => {
        events.push({ refId: e.refId, kind: e.kind, detail: e.detail });
        return Promise.resolve();
      }),
    };
    service = new McPipelineService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      credits as unknown as CreditsService,
      commercials as unknown as CommercialsService,
      { sendCommercialFinished: jest.fn() } as unknown as EmailService,
      { buildPreparationManifest: jest.fn() } as unknown as McMaterializerService,
    );
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const fail = (row: Row, err: unknown) =>
    service.failStep(row as unknown as McStep, McStepStatus.PROVIDER_WAIT, err);
  const alerts = (projectId?: string) =>
    events.filter((e) => e.kind === 'admin_alert' && (!projectId || e.refId === projectId));
  const alertLines = () =>
    errorLog.mock.calls.map(([line]) => String(line)).filter((l) => l.startsWith('ADMIN_ALERT'));
  const saldo = () =>
    new TerminalProviderError('HTTP 403: User is locked. Reason: Exhausted balance', 'quota');

  it('quota: uma execução, estorno, um admin_alert com o motivo técnico e uma linha ADMIN_ALERT', async () => {
    steps.push(talk('t1', 'p1'));
    await fail(steps[0], saldo());

    expect(queue.publish).not.toHaveBeenCalled(); // sem retry
    expect(credits.refundUnconsumed).toHaveBeenCalledWith(expect.anything(), 'u1', 't1', 56, 0);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].detail).toMatchObject({
      errorClass: 'quota',
      errorCode: 'quota',
      stepId: 't1',
      stepType: 'talk',
      provider: 'fal-ai/kling-video/ai-avatar/v2/standard',
    });
    expect(String(alerts()[0].detail.message)).toContain('Exhausted balance');
    const lines = alertLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('projeto=p1');
    expect(lines[0]).toContain('step=t1');
    expect(lines[0]).toContain('Exhausted balance');
    expect(manager.upsert).not.toHaveBeenCalled(); // mc_paused não é ligado
  });

  it('o canal do navegador do cliente não recebe a classe do erro', async () => {
    steps.push(talk('t1', 'p1'));
    await fail(steps[0], saldo());
    const sent = transitions.notify.mock.calls
      .map(([, , payload]) => payload as Record<string, unknown>)
      .find((p) => p.kind === 'mc_admin_alert');
    expect(sent).toEqual({ kind: 'mc_admin_alert', projectId: 'p1' });
  });

  it('a mesma falha processada duas vezes não duplica alerta, log nem estorno', async () => {
    steps.push(talk('t1', 'p1'));
    await fail(steps[0], saldo());
    await fail(steps[0], saldo());
    expect(alerts()).toHaveLength(1);
    expect(alertLines()).toHaveLength(1);
    expect(credits.refundUnconsumed).toHaveBeenCalledTimes(1);
  });

  it('três falas do mesmo projeto sem crédito: um alerta e uma linha, três estornos', async () => {
    steps.push(talk('t1', 'p1'), talk('t2', 'p1'), talk('t3', 'p1'));
    await Promise.all(steps.map((row) => fail(row, saldo())));
    expect(alerts('p1')).toHaveLength(1);
    expect(alertLines()).toHaveLength(1);
    expect(credits.refundUnconsumed).toHaveBeenCalledTimes(3);
  });

  it('dois projetos: dois alertas e duas linhas', async () => {
    steps.push(talk('t1', 'p1'), talk('t2', 'p2'));
    await fail(steps[0], saldo());
    await fail(steps[1], saldo());
    expect(alerts('p1')).toHaveLength(1);
    expect(alerts('p2')).toHaveLength(1);
    expect(alertLines()).toHaveLength(2);
  });

  it('recusa comum (400, provider_rejected) e política de conteúdo não alertam', async () => {
    steps.push(talk('t1', 'p1'), talk('t2', 'p1'));
    await fail(steps[0], new TerminalProviderError('HTTP 400: bad', 'provider_rejected'));
    await fail(steps[1], new TerminalProviderError('HTTP 422', 'content_policy'));
    expect(alerts()).toHaveLength(0);
    expect(alertLines()).toHaveLength(0);
    expect(credits.refundUnconsumed).toHaveBeenCalledTimes(2);
  });

  it('fora do ar (503): 4 execuções com espera 15/30/60 s, depois provider_transient sem alerta', async () => {
    const delays: number[] = [];
    for (const attempts of [1, 2, 3]) {
      steps.splice(0, steps.length, talk('t1', 'p1', { attempts }));
      casWins.clear();
      queue.publish.mockClear();
      await fail(steps[0], new TransientProviderError('HTTP 503'));
      delays.push(queue.publish.mock.calls[0][2].startAfterSeconds as number);
    }
    expect(delays).toEqual([15, 30, 60]);

    steps.splice(0, steps.length, talk('t1', 'p1', { attempts: 4 }));
    casWins.clear();
    queue.publish.mockClear();
    await fail(steps[0], new TransientProviderError('HTTP 503'));
    expect(queue.publish).not.toHaveBeenCalled();
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.GENERATING,
      McProjectStatus.NEEDS_ATTENTION,
      expect.objectContaining({ errorCode: 'provider_transient' }),
    );
    expect(alerts()).toHaveLength(0);
  });
});
