import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** A chave de teste dos specs da busca de fotos: nenhum log, erro, URL nem corpo pode conter este texto. */
export const TEST_SERPER_KEY = 'serper-chave-de-teste-0000';

/** Um `ConfigService` de mentira com as variáveis dadas. */
export const configOf = (values: Record<string, string>): ConfigService =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

/** Tudo o que o `Logger` do Nest recebeu (instância e estático, em todos os níveis), em texto. */
export function captureLogs(): () => string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(record);
    jest.spyOn(Logger, level).mockImplementation(record);
  }
  return () => lines;
}

/** Uma resposta JSON da Serper. */
export const jsonReply = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** Um resultado de `/images` com a forma que a Serper devolve (tamanho em `imageWidth` e `imageHeight`). */
export const serperImage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Coxão Mole Bovino Bife Resfriado kg',
  imageUrl: 'https://www.extrabom.com.br/img/coxao-mole.jpg',
  imageWidth: 1000,
  imageHeight: 1000,
  thumbnailUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc',
  domain: 'extrabom.com.br',
  ...over,
});

/**
 * Faz o `fetch` espionado responder 200 com os cabeçalhos e um corpo que trava até o aborto do controller do provedor (o que
 * o fetch real faz com o stream); devolve o `signal` do pedido, que só existe depois da chamada.
 */
export function respondWithHangingBody(fetchSpy: jest.SpyInstance): { signal?: AbortSignal } {
  const seen: { signal?: AbortSignal } = {};
  fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    seen.signal = signal;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        signal.addEventListener('abort', () =>
          stream.error(
            Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
          ),
        );
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  });
  return seen;
}
