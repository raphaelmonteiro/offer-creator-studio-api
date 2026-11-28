import { Logger } from '@nestjs/common';
import { HttpProviderBase } from './http-provider.base';
import {
  ProviderTimeoutError,
  TerminalProviderError,
  TransientProviderError,
} from './provider-errors';

class Probe extends HttpProviderBase {
  protected readonly logger = new Logger('Probe');
  call(timeoutMs?: number) {
    return this.request<{ ok: boolean }>('https://provider.example/x', {
      method: 'POST',
      timeoutMs,
    });
  }
}

describe('HttpProviderBase: o prazo da chamada é um erro próprio (change 47, D-orq-253)', () => {
  let fetchSpy: jest.SpyInstance;
  const probe = new Probe();

  beforeEach(() => {
    jest.useFakeTimers();
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  /** O fetch que só termina quando o controller da base aborta. */
  const hangUntilAborted = () =>
    fetchSpy.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          ),
        ),
    );

  it('prazo vencido: ProviderTimeoutError, que ainda é TransientProviderError', async () => {
    hangUntilAborted();

    const pending = probe.call(10_000).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(error).toBeInstanceOf(TransientProviderError);
    expect((error as Error).message).toBe('Falha de rede: This operation was aborted');
  });

  it('antes do prazo a chamada segue pendente', async () => {
    hangUntilAborted();
    let settled = false;

    void probe.call(10_000).then(
      () => (settled = true),
      () => (settled = true),
    );
    await jest.advanceTimersByTimeAsync(9_999);

    expect(settled).toBe(false);
  });

  it('queda de rede antes do prazo é transitória e não é de prazo', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const error = await probe.call(10_000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransientProviderError);
    expect(error).not.toBeInstanceOf(ProviderTimeoutError);
  });

  it('resposta de erro segue a classificação de sempre, sem erro de prazo', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"detail":"Invalid key"}', { status: 401 }));
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }));

    const auth = await probe.call().catch((e: unknown) => e);
    const gateway = await probe.call().catch((e: unknown) => e);

    expect(auth).toBeInstanceOf(TerminalProviderError);
    expect(gateway).toBeInstanceOf(TransientProviderError);
    expect(gateway).not.toBeInstanceOf(ProviderTimeoutError);
  });

  it('resposta 200 devolve o JSON e o relógio do prazo não fica pendente', async () => {
    fetchSpy.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await expect(probe.call(10_000)).resolves.toEqual({ ok: true });
    expect(jest.getTimerCount()).toBe(0);
  });
});
