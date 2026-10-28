import { MC_PIPELINE_V2 } from './mc-quality';
import { readySteps, SchedulerScene, SchedulerStep } from './mc-scheduler';
import { McProjectStatus, McSceneStatus, McStepStatus } from './mc-state-machines';
import { McStepType } from './mc-types';

/** Scheduler da fala contínua (change video-fala-continua, 1.4, D6): `requires` do talk de trecho. */
const scene = (id: string, idx: number, status = McSceneStatus.PENDING): SchedulerScene => ({
  id,
  idx,
  generation: 1,
  status,
  dialogue: 'fala',
  sceneType: 'talk_tile',
});

function step(
  sceneId: string | null,
  type: McStepType,
  status: McStepStatus,
  extra: Partial<SchedulerStep> = {},
): SchedulerStep {
  return {
    id: `${sceneId ?? 'proj'}-${type}`,
    sceneId,
    sceneGeneration: sceneId ? 1 : null,
    type,
    status,
    projectRevision: 1,
    attempt: 1,
    ...extra,
  };
}

const project = (status = McProjectStatus.GENERATING, talkMode?: string) => ({
  status,
  pipelineVersion: MC_PIPELINE_V2,
  revision: 1,
  format: 'offer_piece' as const,
  script: talkMode ? { talkMode } : null,
});

const chunkSnapshot = (rowIds: string[], index: number, fromRowId?: string) => ({
  chunk: {
    index,
    count: 2,
    sceneIds: rowIds,
    sceneRowIds: rowIds,
    speeches: [{ sceneRowId: rowIds[0] }],
    join: fromRowId
      ? { fromChunkIndex: index - 1, fromStepHash: 'h', fromSceneRowId: fromRowId }
      : null,
  },
});

const scenes = [scene('a', 0), scene('b', 1), scene('c', 2), scene('d', 3)];
const tts = (done: string[]) =>
  scenes.map((s) =>
    step(s.id, McStepType.TTS, done.includes(s.id) ? McStepStatus.SUCCEEDED : McStepStatus.PENDING),
  );
const ids = (refs: Array<{ id: string }>) => refs.map((r) => r.id);

describe('readySteps — talk de trecho (D6)', () => {
  it('o talk do trecho só sai com o TTS de TODAS as falas dele', () => {
    const talk = step('a', McStepType.TALK, McStepStatus.PENDING, {
      inputSnapshot: chunkSnapshot(['a', 'b'], 0),
    });
    const partial = readySteps(project(), scenes, [...tts(['a']), talk]);
    expect(ids(partial)).not.toContain(talk.id);
    const full = readySteps(project(), scenes, [...tts(['a', 'b']), talk]);
    expect(ids(full)).toContain(talk.id);
  });

  it('o trecho seguinte espera o anterior concluído (junção) e sai quando ele conclui', () => {
    const first = (status: McStepStatus) =>
      step('a', McStepType.TALK, status, { inputSnapshot: chunkSnapshot(['a', 'b'], 0) });
    const second = step('c', McStepType.TALK, McStepStatus.PENDING, {
      inputSnapshot: chunkSnapshot(['c', 'd'], 1, 'a'),
    });
    const all = tts(['a', 'b', 'c', 'd']);
    const running = readySteps(project(), scenes, [
      ...all,
      first(McStepStatus.PROVIDER_WAIT),
      second,
    ]);
    expect(ids(running)).not.toContain(second.id);
    const done = readySteps(project(), scenes, [...all, first(McStepStatus.SUCCEEDED), second]);
    expect(ids(done)).toContain(second.id);
    const cached = readySteps(project(), scenes, [
      ...all,
      first(McStepStatus.SKIPPED_CACHED),
      second,
    ]);
    expect(ids(cached)).toContain(second.id);
  });

  it('trecho anterior com falha NÃO libera o seguinte', () => {
    const failed = step('a', McStepType.TALK, McStepStatus.FAILED, {
      inputSnapshot: chunkSnapshot(['a', 'b'], 0),
    });
    const second = step('c', McStepType.TALK, McStepStatus.PENDING, {
      inputSnapshot: chunkSnapshot(['c', 'd'], 1, 'a'),
    });
    expect(
      ids(readySteps(project(), scenes, [...tts(['a', 'b', 'c', 'd']), failed, second])),
    ).toEqual([]);
  });

  it('talk sem trecho (modo de hoje) continua dependendo só do TTS da própria cena', () => {
    const talk = step('a', McStepType.TALK, McStepStatus.PENDING);
    expect(ids(readySteps(project(), scenes, [...tts(['a']), talk]))).toContain(talk.id);
  });

  it('a montagem espera a cena seguidora (sem step) ficar ready; só o step concluído da líder não basta', () => {
    const compose = step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING);
    const stills = step(null, McStepType.RENDER_STILL, McStepStatus.SUCCEEDED);
    const leader = step('a', McStepType.TALK, McStepStatus.SUCCEEDED, {
      inputSnapshot: chunkSnapshot(['a', 'b'], 0),
    });
    const base = [scene('a', 0, McSceneStatus.READY), scene('b', 1, McSceneStatus.PENDING)];
    const steps = [step('a', McStepType.TTS, McStepStatus.SUCCEEDED), leader, compose, stills];
    expect(ids(readySteps(project(McProjectStatus.GENERATING, 'continuous'), base, steps))).toEqual(
      [],
    );
    const ready = [scene('a', 0, McSceneStatus.READY), scene('b', 1, McSceneStatus.READY)];
    expect(
      ids(readySteps(project(McProjectStatus.GENERATING, 'continuous'), ready, steps)),
    ).toContain(compose.id);
  });
});
