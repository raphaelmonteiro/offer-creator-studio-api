import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { buildFailStepHarness, Row, talk } from './mc-pipeline.fail-step.fixture';
import { McPipelineService } from './mc-pipeline.service';

/**
 * Falha do `talk` de TRECHO (change video-fala-continua, D6): todas as falas do trecho vão a `failed`
 * com o mesmo código, o texto vem do catálogo e há UM admin_alert por projeto.
 */
describe('McPipelineService.failStep — falha do trecho', () => {
  let steps: Row[];
  let events: Array<{ refId: string; kind: string; detail: Record<string, unknown> }>;
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let service: McPipelineService;

  beforeEach(() => {
    ({ steps, events, transitions, service } = buildFailStepHarness());
  });

  afterEach(() => jest.restoreAllMocks());

  const chunkStep = (): Row =>
    talk('t1', 'p1', {
      inputSnapshot: {
        chunk: {
          version: 1,
          index: 0,
          count: 1,
          sceneIds: ['s0', 's1', 's2'],
          sceneRowIds: ['sc-t1', 'row-b', 'row-c'],
          speeches: [{ sceneRowId: 'sc-t1' }],
          join: null,
        },
      },
    });

  const sceneFailures = () =>
    transitions.casTransition.mock.calls.filter(
      (c) => c[1] === McScene && c[4] === McSceneStatus.FAILED,
    );

  it('sem crédito do motor: líder e seguidoras ficam failed com o mesmo código e o texto da P-27; um único admin_alert', async () => {
    steps.push(chunkStep());
    await service.failStep(
      steps[0] as unknown as McStep,
      McStepStatus.PROVIDER_WAIT,
      new TerminalProviderError('HTTP 403: User is locked. Reason: Exhausted balance', 'quota'),
    );
    const failed = sceneFailures();
    expect(failed.map((c) => c[2])).toEqual(['sc-t1', 'row-b', 'row-c']);
    for (const call of failed) {
      expect(call[5]).toMatchObject({
        errorCode: 'quota',
        errorMessage: expect.stringContaining('indisponível no momento'),
      });
      expect(String((call[5] as { errorMessage: string }).errorMessage)).not.toMatch(
        /fal|saldo|balance/i,
      );
    }
    expect(events.filter((e) => e.kind === 'admin_alert')).toHaveLength(1);
  });

  it('talk de uma fala (modo de hoje) falha só a própria cena', async () => {
    steps.push(talk('t2', 'p1'));
    await service.failStep(
      steps[0] as unknown as McStep,
      McStepStatus.PROVIDER_WAIT,
      new TerminalProviderError('HTTP 422: policy', 'content_policy'),
    );
    expect(sceneFailures().map((c) => c[2])).toEqual(['sc-t2']);
  });
});
