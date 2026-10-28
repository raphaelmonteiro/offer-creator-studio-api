import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { McRenderInterruptedError } from '../domain/mc-error-classes';
import { McProjectStatus, McStepStatus } from '../domain/mc-state-machines';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from './mc-pipeline.service';
import { buildFailStepHarness, Row, talk } from './mc-pipeline.fail-step.fixture';

/** Alerta de crédito/chave do fornecedor: um por projeto, log ADMIN_ALERT, sem pausar o módulo (Q2, Q3, Q4). */
describe('McPipelineService.failStep — admin_alert de quota e chave inválida', () => {
  let steps: Row[];
  let events: Array<{ refId: string; kind: string; detail: Record<string, unknown> }>;
  let casWins: Set<string>;
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let credits: { refundUnconsumed: jest.Mock };
  let state: { manager: Record<string, jest.Mock> };
  let errorLog: jest.SpyInstance;
  let service: McPipelineService;

  beforeEach(() => {
    const h = buildFailStepHarness();
    ({ steps, events, casWins, transitions, queue, credits, errorLog, service, state } = h);
  });

  afterEach(() => jest.restoreAllMocks());

  const fail = (row: Row, err: unknown) =>
    service.failStep(row as unknown as McStep, McStepStatus.PROVIDER_WAIT, err);
  const alerts = (projectId?: string) =>
    events.filter((e) => e.kind === 'admin_alert' && (!projectId || e.refId === projectId));
  const alertLines = () =>
    errorLog.mock.calls.map(([line]) => String(line)).filter((l) => l.startsWith('ADMIN_ALERT'));
  const chave = () => new TerminalProviderError('HTTP 401: Invalid key', 'provider_auth');
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
    expect(state.manager.upsert).not.toHaveBeenCalled(); // mc_paused não é ligado
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

  it('chave inválida (provider_auth): falha de configuração com estorno, alerta e sem retry', async () => {
    steps.push(talk('t1', 'p1'));
    await fail(steps[0], chave());
    expect(queue.publish).not.toHaveBeenCalled();
    expect(credits.refundUnconsumed).toHaveBeenCalledWith(expect.anything(), 'u1', 't1', 56, 0);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].detail).toMatchObject({ errorClass: 'config', errorCode: 'provider_auth' });
    expect(alertLines()).toHaveLength(1);
    expect(alertLines()[0]).toContain('ADMIN_ALERT config projeto=p1');
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.GENERATING,
      McProjectStatus.NEEDS_ATTENTION,
      expect.objectContaining({
        errorCode: 'provider_auth',
        errorMessage:
          'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.',
      }),
    );
    expect(state.manager.upsert).not.toHaveBeenCalled(); // mc_paused não é ligado
  });

  it('três falas com chave inválida no mesmo projeto: um alerta e uma linha, três estornos', async () => {
    steps.push(talk('t1', 'p1'), talk('t2', 'p1'), talk('t3', 'p1'));
    await Promise.all(steps.map((row) => fail(row, chave())));
    expect(alerts('p1')).toHaveLength(1);
    expect(alertLines()).toHaveLength(1);
    expect(credits.refundUnconsumed).toHaveBeenCalledTimes(3);
  });

  it('quota e chave inválida no mesmo projeto: ainda um alerta só; em outro projeto, outro alerta', async () => {
    steps.push(talk('t1', 'p1'), talk('t2', 'p1'), talk('t3', 'p2'));
    await fail(steps[0], saldo());
    await fail(steps[1], chave());
    await fail(steps[2], chave());
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

  describe('render_interrupted (D-3 de corrigir-render-remotion-epipe)', () => {
    const interrupted = () =>
      new McRenderInterruptedError('render_media', 'Compositor quit with signal SIGKILL');

    it('1ª execução: nova execução pela fila, sem alerta', async () => {
      steps.push(talk('t1', 'p1', { attempts: 1 }));
      await fail(steps[0], interrupted());
      expect(queue.publish).toHaveBeenCalledTimes(1);
      expect(alerts()).toHaveLength(0);
      expect(alertLines()).toHaveLength(0);
    });

    it('teto esgotado (2 execuções): needs_attention, um admin_alert e uma linha ADMIN_ALERT, sem estorno', async () => {
      steps.push(talk('t1', 'p1', { attempts: 2 }), talk('t2', 'p1', { attempts: 2 }));
      await fail(steps[0], interrupted());
      await fail(steps[1], interrupted());
      expect(queue.publish).not.toHaveBeenCalled();
      expect(credits.refundUnconsumed).not.toHaveBeenCalled();
      expect(alerts('p1')).toHaveLength(1);
      expect(alerts()[0].detail).toMatchObject({
        errorClass: 'internal',
        errorCode: 'render_interrupted',
      });
      expect(alertLines()).toHaveLength(1);
      expect(alertLines()[0]).toContain('ADMIN_ALERT internal projeto=p1');
      expect(state.manager.upsert).not.toHaveBeenCalled();
    });

    it('outro projeto esgotado: outro alerta', async () => {
      steps.push(talk('t1', 'p1', { attempts: 2 }), talk('t2', 'p2', { attempts: 2 }));
      await fail(steps[0], interrupted());
      await fail(steps[1], interrupted());
      expect(alerts('p1')).toHaveLength(1);
      expect(alerts('p2')).toHaveLength(1);
    });

    it('erro interno comum esgotado não alerta', async () => {
      steps.push(talk('t1', 'p1', { attempts: 2 }));
      await fail(steps[0], new Error('bug qualquer'));
      expect(alerts()).toHaveLength(0);
    });
  });
});
