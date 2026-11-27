import { EMPTY_RAW_SUGGESTION, exampleRequest } from '../domain/structure-suggestion.testutil';
import { StructureAiFailure } from '../providers/flyer-pro-structure-ai.port';
import { FlyerProStructureLimiter } from './flyer-pro-structure-limiter';
import {
  bodyOf,
  DOCUMENT_ID,
  documentRow,
  fakePort,
  makeSuggestionService,
  OTHER_DOCUMENT_ID,
} from './flyer-pro-structure-suggestion.service.testutil';
import type { StructureAiResult } from '../domain/structure-ai-request';

const EMPTY: StructureAiResult = {
  suggestion: EMPTY_RAW_SUGGESTION,
  model: 'gpt-6-luna',
  usage: null,
};

/** Um provedor que só responde quando o teste manda, para segurar as chamadas "em andamento". */
function heldPort() {
  const resolvers: Array<(result: StructureAiResult) => void> = [];
  const held = fakePort(() => new Promise<StructureAiResult>((resolve) => resolvers.push(resolve)));
  return { ...held, respond: () => resolvers.forEach((resolve) => resolve(EMPTY)) };
}

const busy = (reason: string, retryAfterSeconds?: unknown) => ({
  status: 429,
  response: {
    code: 'FLYER_PRO_STRUCTURE_AI_BUSY',
    details: { reason, retryAfterSeconds: retryAfterSeconds ?? expect.any(Number) },
  },
});

describe('FlyerProStructureSuggestionService: uma sugestão em andamento por encarte', () => {
  it('o segundo pedido ao mesmo encarte, durante o primeiro, é 429 IN_FLIGHT e não chama o provedor', async () => {
    const { port, suggest, respond } = heldPort();
    const { service } = makeSuggestionService({ port });

    const first = service.suggest(DOCUMENT_ID, bodyOf());
    await Promise.resolve();
    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject(
      busy('IN_FLIGHT', 25),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(suggest).toHaveBeenCalledTimes(1);

    respond();
    await expect(first).resolves.toMatchObject({ source: 'ai' });
  });

  it('encartes diferentes correm juntos', async () => {
    const { port, suggest, respond } = heldPort();
    const { service } = makeSuggestionService({ port });

    const first = service.suggest(DOCUMENT_ID, bodyOf());
    const second = service.suggest(OTHER_DOCUMENT_ID, bodyOf());
    await new Promise((resolve) => setImmediate(resolve));
    expect(suggest).toHaveBeenCalledTimes(2);

    respond();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it.each([
    ['depois de um 200', undefined],
    ['depois do 503 do provedor', new StructureAiFailure('PROVIDER_ERROR', 'x')],
    ['depois do prazo', new StructureAiFailure('TIMEOUT', 'x')],
  ])('a vaga é solta %s: o pedido seguinte não é 429 IN_FLIGHT', async (_name, failure) => {
    const { port } = fakePort(failure ?? EMPTY);
    const { service, limiter } = makeSuggestionService({ port });

    await service.suggest(DOCUMENT_ID, bodyOf()).catch(() => undefined);

    expect(limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');
  });

  it('a vaga é solta também quando o pedido é recusado depois de tomá-la (404, páginas, itens)', async () => {
    const notFound = makeSuggestionService({ document: null });
    await expect(notFound.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 404,
    });
    expect(notFound.limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');

    const pages = makeSuggestionService({ document: documentRow({ format: '54x40' }) });
    await expect(
      pages.service.suggest(
        DOCUMENT_ID,
        bodyOf({
          pageCount: 3,
          pages: [1, 2, 3].map((page) => ({
            page,
            capacityCells: 8,
            usedCells: 1,
            header: false,
            footer: false,
          })),
        }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(pages.limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');

    const noItems = makeSuggestionService({ items: [] });
    await expect(noItems.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
    });
    expect(noItems.limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');
  });
});

describe('FlyerProStructureSuggestionService: teto de sugestões atendidas por hora', () => {
  it('com o teto atingido, o pedido é 429 HOURLY_LIMIT com retryAfterSeconds e não chama o provedor nem lê o banco', async () => {
    const clock = { now: 10_000_000 };
    const limiter = new FlyerProStructureLimiter(() => clock.now);
    const { port, suggest } = fakePort(EMPTY);
    const { service, mocks } = makeSuggestionService({ limiter, port, config: { maxPerHour: 20 } });
    clock.now -= 41 * 60_000;
    limiter.recordServed(DOCUMENT_ID);
    clock.now += 22 * 60_000;
    for (let i = 0; i < 19; i += 1) limiter.recordServed(DOCUMENT_ID);
    clock.now += 19 * 60_000;

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject(
      busy('HOURLY_LIMIT', 1140),
    );

    expect(suggest).not.toHaveBeenCalled();
    expect(mocks.findOne).not.toHaveBeenCalled();
    expect(limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');
  });

  it('o IN_FLIGHT vence o HOURLY_LIMIT quando os dois valem', async () => {
    const limiter = new FlyerProStructureLimiter();
    const { port, respond } = heldPort();
    const { service } = makeSuggestionService({ limiter, port, config: { maxPerHour: 1 } });
    const first = service.suggest(DOCUMENT_ID, bodyOf());
    await new Promise((resolve) => setImmediate(resolve));
    limiter.recordServed(DOCUMENT_ID);

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject(busy('IN_FLIGHT'));

    respond();
    await first;
  });

  it('a resposta 200 conta; o pedido depois do teto é 429; outro encarte não é afetado', async () => {
    const { service } = makeSuggestionService({ config: { maxPerHour: 2 } });

    await service.suggest(DOCUMENT_ID, bodyOf());
    await service.suggest(DOCUMENT_ID, bodyOf());

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject(
      busy('HOURLY_LIMIT'),
    );
    await expect(service.suggest(OTHER_DOCUMENT_ID, bodyOf())).resolves.toBeDefined();
  });

  it('falha do provedor (PROVIDER_ERROR, TIMEOUT e INVALID_OUTPUT) não conta: depois dela o pedido passa e só então bloqueia', async () => {
    const outcomes: Array<StructureAiResult | Error> = [
      EMPTY,
      EMPTY,
      new StructureAiFailure('PROVIDER_ERROR', 'x'),
      new StructureAiFailure('TIMEOUT', 'x'),
      new StructureAiFailure('INVALID_OUTPUT', 'x'),
      EMPTY,
    ];
    const queue = [...outcomes];
    const { port } = fakePort(() => {
      const next = queue.shift() as StructureAiResult | Error;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    const { service } = makeSuggestionService({ port, config: { maxPerHour: 3 } });

    await service.suggest(DOCUMENT_ID, bodyOf());
    await service.suggest(DOCUMENT_ID, bodyOf());
    for (let i = 0; i < 3; i += 1) {
      await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({ status: 503 });
    }
    await expect(service.suggest(DOCUMENT_ID, bodyOf())).resolves.toBeDefined();

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject(
      busy('HOURLY_LIMIT'),
    );
  });

  it('pedido recusado antes do provedor não conta (422 de retrato, função, 404, itens, páginas)', async () => {
    const { service, limiter } = makeSuggestionService({ config: { maxPerHour: 2 } });
    const invalid = bodyOf({ sections: exampleRequest().sections.slice(0, 1) });
    for (let i = 0; i < 5; i += 1) {
      await expect(service.suggest(DOCUMENT_ID, invalid)).rejects.toMatchObject({ status: 422 });
    }
    const noItems = makeSuggestionService({ items: [], config: { maxPerHour: 2 }, limiter });
    await expect(noItems.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
    });
    const notFound = makeSuggestionService({ document: null, config: { maxPerHour: 2 }, limiter });
    await expect(notFound.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 404,
    });
    const disabled = makeSuggestionService({ config: { enabled: false, maxPerHour: 2 }, limiter });
    await expect(disabled.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
    });

    await service.suggest(DOCUMENT_ID, bodyOf());
    await service.suggest(DOCUMENT_ID, bodyOf());
    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject(
      busy('HOURLY_LIMIT'),
    );
  });
});
