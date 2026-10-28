import { trackChildWork } from './in-flight-child-work';
import {
  installProcessErrorHandlers,
  isChildPipeError,
  ProcessLike,
  WORKER_FATAL_GRACE_MS,
} from './process-error-handlers';

type Listener = (reason: unknown) => void;

function setup(over: { shutdown?: () => Promise<unknown>; hasChildWork?: () => boolean } = {}) {
  const listeners: Record<string, Listener> = {};
  const proc: ProcessLike = {
    on: (event, listener) => {
      listeners[event] = listener;
    },
  };
  const logger = { error: jest.fn() };
  const shutdown = jest.fn(over.shutdown ?? (() => Promise.resolve()));
  const exit = jest.fn();
  installProcessErrorHandlers(proc, { logger, shutdown, exit, hasChildWork: over.hasChildWork });
  return { listeners, proc, logger, shutdown, exit };
}

const pipeError = (code = 'EPIPE') =>
  Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });

describe('isChildPipeError', () => {
  it.each(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])(
    'reconhece %s',
    (code) => expect(isChildPipeError(pipeError(code))).toBe(true),
  );

  it('spawn que falhou ao executar (ENOENT, EACCES, ENOEXEC com syscall spawn)', () => {
    for (const code of ['ENOENT', 'EACCES', 'ENOEXEC']) {
      expect(
        isChildPipeError(Object.assign(new Error('x'), { code, syscall: 'spawn chrome' })),
      ).toBe(true);
    }
  });

  it('ENOENT de leitura de arquivo e erros comuns não são erro de pipe', () => {
    expect(
      isChildPipeError(Object.assign(new Error('x'), { code: 'ENOENT', syscall: 'open' })),
    ).toBe(false);
    expect(isChildPipeError(new TypeError('x is not a function'))).toBe(false);
    expect(isChildPipeError(null)).toBe(false);
    expect(isChildPipeError('EPIPE')).toBe(false);
  });
});

describe('installProcessErrorHandlers (política do worker)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('EPIPE com render em andamento: segue de pé, loga error com mensagem e pilha, sem shutdown nem exit', () => {
    const { listeners, logger, shutdown, exit, proc } = setup({ hasChildWork: () => true });
    const err = pipeError();
    listeners.uncaughtException(err);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('EPIPE write EPIPE'),
      err.stack,
    );
    expect(logger.error.mock.calls[0][0]).toContain('reconhecido');
    expect(shutdown).not.toHaveBeenCalled();
    jest.advanceTimersByTime(WORKER_FATAL_GRACE_MS * 2);
    expect(exit).not.toHaveBeenCalled();
    expect(proc.exitCode).toBeUndefined();
  });

  it('usa o contador real: reconhece enquanto trackChildWork está ativo e deixa de reconhecer depois', async () => {
    const { listeners, shutdown } = setup(); // hasChildWork padrão
    let release: () => void = () => undefined;
    const running = trackChildWork(() => new Promise<void>((resolve) => (release = resolve)));
    listeners.uncaughtException(pipeError());
    expect(shutdown).not.toHaveBeenCalled();
    release();
    await running;
    listeners.uncaughtException(pipeError());
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('EPIPE sem render em andamento é tratado como desconhecido (encerramento controlado)', () => {
    const { listeners, shutdown } = setup({ hasChildWork: () => false });
    listeners.uncaughtException(pipeError());
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('uncaughtException desconhecida: loga, exitCode 1, shutdown e exit(1) assim que o shutdown termina', async () => {
    const { listeners, logger, shutdown, exit, proc } = setup();
    const err = new TypeError('boom');
    listeners.uncaughtException(err);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('uncaughtException fatal'),
      err.stack,
    );
    expect(proc.exitCode).toBe(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('shutdown que pendura: exit(1) só depois da carência de 10 s', async () => {
    const { listeners, exit } = setup({ shutdown: () => new Promise(() => undefined) });
    listeners.uncaughtException(new Error('boom'));
    await jest.advanceTimersByTimeAsync(WORKER_FATAL_GRACE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('shutdown que falha: registra e ainda sai com 1', async () => {
    const { listeners, logger, exit } = setup({
      shutdown: () => Promise.reject(new Error('app.close falhou')),
    });
    listeners.uncaughtException(new Error('boom'));
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.error.mock.calls.map(([m]) => m).join('\n')).toContain('app.close falhou');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('segunda exceção durante o encerramento só é registrada (um shutdown, um exit)', async () => {
    const { listeners, logger, shutdown, exit } = setup({
      shutdown: () => new Promise(() => undefined),
    });
    listeners.uncaughtException(new Error('primeira'));
    listeners.uncaughtException(new Error('segunda'));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(
      logger.error.mock.calls.some(([m]) => String(m).includes('durante o encerramento: segunda')),
    ).toBe(true);
    await jest.advanceTimersByTimeAsync(WORKER_FATAL_GRACE_MS);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('unhandledRejection comum: loga error com a pilha e o worker segue (sem shutdown)', async () => {
    const { listeners, logger, shutdown, exit } = setup();
    const err = new Error('promessa esquecida');
    listeners.unhandledRejection(err);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unhandledRejection não reconhecida'),
      err.stack,
    );
    await jest.advanceTimersByTimeAsync(WORKER_FATAL_GRACE_MS);
    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('unhandledRejection que não é Error é logada com String(reason); EPIPE com render segue reconhecido', () => {
    const { listeners, logger } = setup({ hasChildWork: () => true });
    listeners.unhandledRejection('texto solto');
    expect(logger.error.mock.calls[0][0]).toContain('texto solto');
    listeners.unhandledRejection(pipeError());
    expect(logger.error.mock.calls[1][0]).toContain('reconhecido');
  });

  it('nenhum erro passa sem log: toda chamada ao handler gera ao menos um logger.error', () => {
    const { listeners, logger } = setup({ hasChildWork: () => true });
    listeners.unhandledRejection(new Error('a'));
    listeners.unhandledRejection(pipeError());
    listeners.uncaughtException(pipeError());
    listeners.uncaughtException(new Error('b'));
    expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
