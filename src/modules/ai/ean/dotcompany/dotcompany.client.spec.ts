import { Logger } from '@nestjs/common';
import {
  DotcompanyAuthError,
  DotcompanyClient,
  DotcompanyError,
  DotcompanyIdempotencyError,
  DotcompanyNoCreditError,
  DotcompanyRateLimitedError,
  DotcompanyTransientError,
} from './dotcompany.client';

const TOKEN = 'dc_test_1.segredo-que-nao-pode-vazar';

function resposta(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function criar(fetchMock: jest.Mock, token: string | undefined = TOKEN) {
  const config = {
    get: (k: string) => (k === 'DOTCOMPANY_API_TOKEN' ? token : undefined),
  };
  const sleep = jest.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
  const client = new DotcompanyClient(config as never);
  client.fetchImpl = fetchMock as never;
  client.sleep = sleep;
  return { client, sleep };
}

describe('DotcompanyClient', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('sem token recusa sem chamar a rede', async () => {
    const f = jest.fn();
    const { client } = criar(f, '');
    expect(client.isConfigured()).toBe(false);
    await expect(client.lookupBatch(['7891000100103'])).rejects.toBeInstanceOf(DotcompanyAuthError);
    expect(f).not.toHaveBeenCalled();
  });

  it('lote: envia Bearer, Idempotency-Key e devolve itens + custo + janela', async () => {
    const f = jest.fn().mockResolvedValue(
      resposta(
        200,
        {
          total: 2,
          encontrados: 1,
          itens: [
            {
              gtin: '7891000100103',
              encontrado: true,
              produto: { gtin: '7891000100103', nome: 'MOÇA' },
            },
            { gtin: '7894900011517', encontrado: false },
          ],
        },
        {
          'X-DotCompany-Credits-Charged': '4',
          'X-RateLimit-Limit': '30',
          'X-RateLimit-Remaining': '29',
          'X-RateLimit-Reset': '1792627260',
          'X-Request-Id': 'r1',
        },
      ),
    );
    const { client } = criar(f);
    const r = await client.lookupBatch(['7891000100103', '7894900011517'], {
      idempotencyKey: 'k-1',
    });

    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://erp.dotcompany.com.br/api/v1/catalogo/gtin/batch');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['Idempotency-Key']).toBe('k-1');
    expect(JSON.parse(init.body)).toEqual({ gtins: ['7891000100103', '7894900011517'] });
    expect(r.items).toHaveLength(2);
    expect(r.creditsCharged).toBe(4);
    expect(r.rate).toEqual({ limit: 30, remaining: 29, reset: 1792627260 });
    expect(r.requestId).toBe('r1');
  });

  it('recusa lote vazio ou acima de 100', async () => {
    const { client } = criar(jest.fn());
    await expect(client.lookupBatch([])).rejects.toThrow();
    await expect(
      client.lookupBatch(Array.from({ length: 101 }, () => '7891000100103')),
    ).rejects.toThrow();
  });

  it('single com ETag: 304 = não mudou, sem custo', async () => {
    const f = jest.fn().mockResolvedValue(resposta(304, null, { ETag: '"abc"' }));
    const { client } = criar(f);
    const r = await client.lookupSingle('7891000100103', { etag: '"abc"' });
    expect(f.mock.calls[0][1].headers['If-None-Match']).toBe('"abc"');
    expect(r.notModified).toBe(true);
    expect(r.creditsCharged).toBe(0);
    expect(r.etag).toBe('"abc"');
  });

  it('single 200 devolve item e ETag', async () => {
    const f = jest.fn().mockResolvedValue(
      resposta(
        200,
        {
          encontrado: true,
          gtin: '7891000100103',
          produto: { gtin: '7891000100103', nome: 'MOÇA' },
          codigo_valido: true,
        },
        { ETag: '"v2"' },
      ),
    );
    const { client } = criar(f);
    const r = await client.lookupSingle('7891000100103');
    expect(r.notModified).toBe(false);
    expect(r.item?.produto?.nome).toBe('MOÇA');
    expect(r.etag).toBe('"v2"');
  });

  it('usage devolve o saldo disponível', async () => {
    const f = jest
      .fn()
      .mockResolvedValue(resposta(200, { saldo: { disponivel: 2960, credito_baixo: false } }));
    const { client } = criar(f);
    expect((await client.usage()).available).toBe(2960);
  });

  it('402 vira DotcompanyNoCreditError, sem nova tentativa', async () => {
    const f = jest
      .fn()
      .mockResolvedValue(
        resposta(
          402,
          { detail: 'Seus creditos acabaram', code: 'INSUFFICIENT_CREDITS' },
          { 'X-Error-Code': 'INSUFFICIENT_CREDITS' },
        ),
      );
    const { client } = criar(f);
    const err = await client.lookupBatch(['7891000100103']).catch((e) => e);
    expect(err).toBeInstanceOf(DotcompanyNoCreditError);
    expect(err.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('%s vira DotcompanyAuthError, sem nova tentativa', async (status) => {
    const f = jest.fn().mockResolvedValue(resposta(status, {}));
    const { client } = criar(f);
    await expect(client.lookupBatch(['7891000100103'])).rejects.toBeInstanceOf(DotcompanyAuthError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('429 com Retry-After curto: espera e repete uma vez', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(resposta(429, {}, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(resposta(200, { itens: [] }));
    const { client, sleep } = criar(f);
    await client.lookupBatch(['7891000100103']);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('429 com Retry-After longo: devolve o tempo ao chamador sem dormir', async () => {
    const f = jest
      .fn()
      .mockResolvedValue(
        resposta(429, {}, { 'Retry-After': '40', 'X-Error-Code': 'RATE_LIMITED' }),
      );
    const { client, sleep } = criar(f);
    const err = await client.lookupBatch(['7891000100103']).catch((e) => e);
    expect(err).toBeInstanceOf(DotcompanyRateLimitedError);
    expect(err.retryAfterSec).toBe(40);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('5xx: tenta de novo com espera crescente e desiste depois de 3 novas tentativas', async () => {
    const f = jest.fn().mockResolvedValue(resposta(503, {}));
    const { client, sleep } = criar(f);
    await expect(client.lookupBatch(['7891000100103'])).rejects.toBeInstanceOf(
      DotcompanyTransientError,
    );
    expect(f).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
  });

  it('falha de rede recupera na tentativa seguinte', async () => {
    const f = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(resposta(200, { itens: [] }));
    const { client } = criar(f);
    await expect(client.lookupBatch(['7891000100103'])).resolves.toMatchObject({ items: [] });
  });

  it('X-Idempotency-Replay: true marca a resposta como replay (sem novo débito)', async () => {
    const f = jest
      .fn()
      .mockResolvedValue(
        resposta(
          200,
          { itens: [] },
          { 'X-Idempotency-Replay': 'true', 'X-DotCompany-Credits-Charged': '0' },
        ),
      );
    const { client } = criar(f);
    const r = await client.lookupBatch(['7891000100103'], { idempotencyKey: 'k' });
    expect(r.replay).toBe(true);
    expect(r.creditsCharged).toBe(0);
    const normal = criar(jest.fn().mockResolvedValue(resposta(200, { itens: [] })));
    expect((await normal.client.lookupBatch(['7891000100103'])).replay).toBe(false);
  });

  it.each([
    ['IDEMPOTENCY_IN_FLIGHT', false],
    ['IDEMPOTENCY_KEY_ORPHANED', false],
    ['IDEMPOTENCY_KEY_CONFLICT', true],
  ])('409 %s vira DotcompanyIdempotencyError, sem nova tentativa', async (code, conflito) => {
    const f = jest.fn().mockResolvedValue(resposta(409, { detail: 'x' }, { 'X-Error-Code': code }));
    const { client } = criar(f);
    const err = await client
      .lookupBatch(['7891000100103'], { idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DotcompanyIdempotencyError);
    expect((err as DotcompanyIdempotencyError).errorCode).toBe(code);
    expect((err as DotcompanyIdempotencyError).keyConflict).toBe(conflito);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('422 é erro de uso: não repete', async () => {
    const f = jest.fn().mockResolvedValue(resposta(422, { detail: 'invalido' }));
    const { client } = criar(f);
    const err = await client.lookupBatch(['7891000100103']).catch((e) => e);
    expect(err).toBeInstanceOf(DotcompanyError);
    expect(err.status).toBe(422);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('o token nunca aparece em mensagem de erro nem em log', async () => {
    const f = jest.fn().mockResolvedValue(resposta(402, { detail: 'sem credito' }));
    const { client } = criar(f);
    const err = await client.lookupBatch(['7891000100103']).catch((e) => e);
    expect(String(err.message)).not.toContain(TOKEN);
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
  });
});
