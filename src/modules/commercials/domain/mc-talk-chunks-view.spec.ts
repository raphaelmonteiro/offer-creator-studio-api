import { McStepStatus } from './mc-state-machines';
import { chunkStatusOf, talkChunksView } from './mc-talk-chunks-view';
import { McStepType } from './mc-types';

const talk = (
  id: string,
  index: number,
  status: McStepStatus,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type: McStepType.TALK,
  status,
  attempt: 1,
  projectRevision: 1,
  inputSnapshot: {
    chunk: {
      index,
      count: 2,
      sceneIds: [`s${index * 2}`, `s${index * 2 + 1}`],
      sceneRowIds: ['a', 'b'],
      speeches: [{ sceneRowId: 'a' }],
      sentMs: 8785,
    },
  },
  ...extra,
});

describe('talkChunksView (D13)', () => {
  it('lista os trechos da revisão corrente com as falas, o estado do step e os segundos enviados', () => {
    const view = talkChunksView({ talkMode: 'continuous' }, 1, [
      talk('t0', 0, McStepStatus.SUCCEEDED),
      talk('t1', 1, McStepStatus.PROVIDER_WAIT),
    ]);
    expect(view).toEqual([
      { index: 0, sceneIds: ['s0', 's1'], status: 'ready', billedSeconds: 8.785, stepId: 't0' },
      { index: 1, sceneIds: ['s2', 's3'], status: 'running', billedSeconds: 8.785, stepId: 't1' },
    ]);
  });

  it('a tentativa mais recente do trecho vence; steps de outra revisão e de talk sem trecho são ignorados', () => {
    const view = talkChunksView({ talkMode: 'continuous' }, 2, [
      talk('old', 0, McStepStatus.SUCCEEDED, { projectRevision: 1 }),
      talk('a1', 0, McStepStatus.FAILED, { projectRevision: 2, attempt: 1 }),
      talk('a2', 0, McStepStatus.PENDING, { projectRevision: 2, attempt: 2 }),
      { id: 'legacy', type: McStepType.TALK, status: McStepStatus.SUCCEEDED, inputSnapshot: {} },
    ]);
    expect(view).toEqual([expect.objectContaining({ index: 0, stepId: 'a2', status: 'pending' })]);
  });

  it('null fora do modo contínuo e antes de existir um talk de trecho', () => {
    expect(talkChunksView({}, 1, [talk('t0', 0, McStepStatus.SUCCEEDED)])).toBeNull();
    expect(talkChunksView(null, 1, [])).toBeNull();
    expect(talkChunksView({ talkMode: 'continuous' }, 1, [])).toBeNull();
  });

  it('mapeia os estados do step: failed, running e pending (cancelado e cache incluídos)', () => {
    expect(chunkStatusOf(McStepStatus.FAILED)).toBe('failed');
    expect(chunkStatusOf(McStepStatus.QUEUED)).toBe('running');
    expect(chunkStatusOf(McStepStatus.INGESTING)).toBe('running');
    expect(chunkStatusOf(McStepStatus.SKIPPED_CACHED)).toBe('ready');
    expect(chunkStatusOf(McStepStatus.CANCELED)).toBe('pending');
  });
});
