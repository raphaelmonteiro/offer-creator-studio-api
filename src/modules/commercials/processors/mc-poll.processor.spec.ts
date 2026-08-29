import { DataSource } from 'typeorm';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { McPollProcessor } from './mc-poll.processor';

describe('McPollProcessor — polling com backoff e timeout duro (plano §6.4)', () => {
  const model = 'fal-ai/kling-video/ai-avatar/v2/standard';
  const baseStep = {
    id: 'st-1',
    projectId: 'p1',
    sceneId: 'sc1',
    type: McStepType.LIPSYNC,
    status: McStepStatus.PROVIDER_WAIT,
    provider: model,
    providerJobId: 'req-1',
    startedAt: new Date(),
    costCredits: 56,
  };
  const project = { id: 'p1', userId: 'u1' };

  let stepRow: Record<string, unknown>;
  let pipeline: { failStep: jest.Mock; notifyStep: jest.Mock };
  let transitions: { casTransition: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let queue: { publish: jest.Mock };
  let fal: { status: jest.Mock };
  let processor: McPollProcessor;

  beforeEach(() => {
    stepRow = { ...baseStep };
    pipeline = {
      failStep: jest.fn().mockResolvedValue(undefined),
      notifyStep: jest.fn().mockResolvedValue(undefined),
    };
    transitions = { casTransition: jest.fn().mockResolvedValue(true) };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    fal = { status: jest.fn().mockResolvedValue({ status: 'IN_PROGRESS' }) };
    const dataSource = {
      getRepository: jest.fn(() => ({
        findOneBy: jest.fn().mockResolvedValue(stepRow),
      })),
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) =>
        cb({ findOneByOrFail: jest.fn().mockResolvedValue(project) }),
      ),
    };
    processor = new McPollProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      transitions as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      queue as unknown as AnimationQueueService,
      fal as unknown as FalQueueClient,
      { mockJobAbsPath: jest.fn() } as unknown as McStorageService,
    );
  });

  it('step fora de provider_wait → no-op absoluto', async () => {
    stepRow.status = McStepStatus.INGESTING;
    await processor.process({ stepId: 'st-1', attempt: 2 });
    expect(fal.status).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
    expect(pipeline.failStep).not.toHaveBeenCalled();
  });

  it('IN_PROGRESS → reagenda com backoff 15/30/60 (cap) e singletonKey COM a tentativa', async () => {
    await processor.process({ stepId: 'st-1', attempt: 1, statusUrl: 's', responseUrl: 'r' });
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_POLL,
      expect.objectContaining({ stepId: 'st-1', attempt: 2, statusUrl: 's', responseUrl: 'r' }),
      expect.objectContaining({ startAfterSeconds: 15, singletonKey: 'poll:st-1:2' }),
    );

    queue.publish.mockClear();
    await processor.process({ stepId: 'st-1', attempt: 2 });
    expect(queue.publish.mock.calls[0][2]).toMatchObject({
      startAfterSeconds: 30,
      singletonKey: 'poll:st-1:3',
    });

    queue.publish.mockClear();
    await processor.process({ stepId: 'st-1', attempt: 9 });
    expect(queue.publish.mock.calls[0][2]).toMatchObject({
      startAfterSeconds: 60, // cap
      singletonKey: 'poll:st-1:10',
    });
  });

  it('usa a statusUrl do payload; sem payload reconstrói de provider+jobId', async () => {
    await processor.process({ stepId: 'st-1', attempt: 1, statusUrl: 'https://x/status' });
    expect(fal.status).toHaveBeenCalledWith('https://x/status');

    fal.status.mockClear();
    await processor.process({ stepId: 'st-1', attempt: 1 });
    expect(fal.status).toHaveBeenCalledWith(`https://queue.fal.run/${model}/requests/req-1/status`);
  });

  it('COMPLETED → CAS provider_wait→ingesting + job mc.ingest com a responseUrl', async () => {
    fal.status.mockResolvedValue({ status: 'COMPLETED' });
    await processor.process({ stepId: 'st-1', attempt: 3, responseUrl: 'https://r/1' });
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McStep,
      'st-1',
      McStepStatus.PROVIDER_WAIT,
      McStepStatus.INGESTING,
    );
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_INGEST,
      { stepId: 'st-1', responseUrl: 'https://r/1' },
      expect.objectContaining({ expireInSeconds: 300 }),
    );
  });

  it('timeout DURO de 15 min → failStep classe provider_timeout, sem consultar o provider', async () => {
    stepRow.startedAt = new Date(Date.now() - 16 * 60 * 1000);
    await processor.process({ stepId: 'st-1', attempt: 5 });
    expect(fal.status).not.toHaveBeenCalled();
    expect(pipeline.failStep).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-1' }),
      McStepStatus.PROVIDER_WAIT,
      expect.any(Error),
      expect.objectContaining({ errorClass: 'provider_timeout' }),
    );
  });

  it('erro TERMINAL do provider → failStep terminal (sem reagendar)', async () => {
    fal.status.mockRejectedValue(
      new TerminalProviderError('status desconhecido', 'invalid_provider_output'),
    );
    await processor.process({ stepId: 'st-1', attempt: 1 });
    expect(pipeline.failStep).toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('erro TRANSIENTE (rede) → reagenda o poll em vez de falhar', async () => {
    fal.status.mockRejectedValue(new TransientProviderError('rede'));
    await processor.process({ stepId: 'st-1', attempt: 2 });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_POLL,
      expect.objectContaining({ attempt: 3 }),
      expect.objectContaining({ singletonKey: 'poll:st-1:3' }),
    );
  });

  it('projeto não é consultado à toa: transição para ingesting registra evento no manager da transação', async () => {
    fal.status.mockResolvedValue({ status: 'COMPLETED' });
    await processor.process({ stepId: 'st-1', attempt: 1 });
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refId: 'st-1', toStatus: McStepStatus.INGESTING }),
    );
    expect(pipeline.notifyStep).toHaveBeenCalled();
  });
});
