import { Logger } from '@nestjs/common';
import { HttpProviderBase } from './http-provider.base';
import {
  ProviderTimeoutError,
  TerminalProviderError,
  TransientProviderError,
} from './provider-errors';

class Probe extends HttpProviderBase {
  protected readonly logger = new Logger('Probe');
  call(timeoutMs?: number, timeoutCoversBody?: boolean) {
    return this.request<{ ok: boolean }>('https://provider.example/x', {
      method: 'POST',
      timeoutMs,
      timeoutCoversBody,
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

describe('HttpProviderBase: timeoutCoversBody, o prazo que cobre a leitura do corpo (change 47, D-orq-267)', () => {
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

  /** Cabeçalhos que chegam e um corpo que trava até o aborto do controller da base (o que o fetch real faz com o stream). */
  const headersThenHangingBody = (status: number) =>
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          init.signal?.addEventListener('abort', () =>
            stream.error(
              Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
            ),
          );
        },
      });
      return Promise.resolve(new Response(body, { status }));
    });

  it('ligado: o corpo que trava depois dos cabeçalhos é abortado no prazo e vira ProviderTimeoutError', async () => {
    headersThenHangingBody(200);

    const pending = probe.call(10_000, true).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const error = await pending;

    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(error).toBeInstanceOf(TransientProviderError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ligado: o corpo de uma recusa 4xx que trava também é prazo, não uma recusa com corpo vazio', async () => {
    headersThenHangingBody(400);

    const pending = probe.call(10_000, true).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBeInstanceOf(ProviderTimeoutError);
  });

  it('desligado (o padrão): o corpo que trava segue fora do prazo, como sempre foi', async () => {
    headersThenHangingBody(200);
    let settled = false;

    void probe.call(10_000).then(
      () => (settled = true),
      () => (settled = true),
    );
    await jest.advanceTimersByTimeAsync(600_000);

    expect(settled).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ligado e o corpo chega a tempo: devolve o JSON e o relógio não fica pendente', async () => {
    fetchSpy.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await expect(probe.call(10_000, true)).resolves.toEqual({ ok: true });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ligado: a classificação das respostas de erro e o JSON inválido seguem como no modo padrão', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"detail":"Invalid key"}', { status: 401 }));
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 502 }));
    fetchSpy.mockResolvedValueOnce(new Response('<html>erro</html>', { status: 200 }));

    const auth = await probe.call(10_000, true).catch((e: unknown) => e);
    const gateway = await probe.call(10_000, true).catch((e: unknown) => e);
    const notJson = await probe.call(10_000, true).catch((e: unknown) => e);

    expect(auth).toBeInstanceOf(TerminalProviderError);
    expect(gateway).toBeInstanceOf(TransientProviderError);
    expect(gateway).not.toBeInstanceOf(ProviderTimeoutError);
    expect((notJson as Error).name).toBe('SyntaxError');
    expect(notJson).not.toBeInstanceOf(TransientProviderError);
    expect(jest.getTimerCount()).toBe(0);
  });
});
