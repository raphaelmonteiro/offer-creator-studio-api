import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { McStepStatus } from './mc-state-machines';
import { McStepType } from './mc-types';
import { McOrphanStep, mcDefaultResponseUrl, mcWatchdogTarget } from './mc-watchdog';

const base = (over: Partial<McOrphanStep>): McOrphanStep => ({
  id: 'step-1',
  projectId: 'proj-1',
  type: McStepType.LIPSYNC,
  status: McStepStatus.INGESTING,
  provider: 'fal-ai/kling-video/ai-avatar/v2/standard',
  providerJobId: 'req-123',
  ...over,
});

describe('mcWatchdogTarget', () => {
  it('queued → refila na fila do próprio tipo com {stepId, projectId}', () => {
    const t = mcWatchdogTarget(base({ status: McStepStatus.QUEUED, type: McStepType.TTS }), 1000);
    expect(t?.queue).toBe(QUEUES.MC_TTS);
    expect(t?.payload).toEqual({ stepId: 'step-1', projectId: 'proj-1' });
    expect(t?.options.expireInSeconds).toBeGreaterThan(0);
  });

  it('provider_wait → volta pelo poll com attempt 0 e singletonKey único', () => {
    const t = mcWatchdogTarget(base({ status: McStepStatus.PROVIDER_WAIT }), 42);
    expect(t?.queue).toBe(QUEUES.MC_POLL);
    expect(t?.payload).toEqual({ stepId: 'step-1', attempt: 0 });
    expect(t?.options.singletonKey).toBe('poll:step-1:w42');
  });

  it('ingesting → refila o ingest com a responseUrl reconstruída', () => {
    const t = mcWatchdogTarget(base({}), 1000);
    expect(t?.queue).toBe(QUEUES.MC_INGEST);
    expect(t?.payload).toEqual({
      stepId: 'step-1',
      responseUrl:
        'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard/requests/req-123',
    });
  });

  it('estados fora do escopo (pending/succeeded/failed) não geram reposição', () => {
    for (const status of [
      McStepStatus.PENDING,
      McStepStatus.SUCCEEDED,
      McStepStatus.FAILED,
      McStepStatus.RUNNING,
    ]) {
      expect(mcWatchdogTarget(base({ status }), 1000)).toBeNull();
    }
  });

  it('mcDefaultResponseUrl segue a mesma regra determinística do poll', () => {
    expect(mcDefaultResponseUrl(base({}))).toContain('/requests/req-123');
  });
});
