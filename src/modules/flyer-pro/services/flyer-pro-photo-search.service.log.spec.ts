import { HttpException } from '@nestjs/common';
import { SerperPhotoSearch } from '../providers/flyer-pro-photo-search.serper';
import {
  captureLogs,
  jsonReply,
  serperImage,
  TEST_SERPER_KEY,
} from '../providers/flyer-pro-photo-search.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  fakePhotoPort,
  ITEM_ID,
  makePhotoSearchService,
  tenPhotos,
} from './flyer-pro-photo-search.service.testutil';

const START = new Date('2026-11-28T10:00:00Z');
const TERM = 'COXÃO MOLE BIFE KG';

describe('FlyerProPhotoSearchService: registro de cada busca paga', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const serperService = () =>
    makePhotoSearchService({ port: new SerperPhotoSearch(TEST_SERPER_KEY) }).service;

  it('cada busca que sai para a Serper deixa uma linha com encarte, item, página, status e duração, sem o termo nem a chave', async () => {
    const logs = captureLogs();
    fetchSpy.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(1_500);
      return jsonReply({ images: [serperImage()] });
    });
    fetchSpy.mockResolvedValueOnce(jsonReply('', 500));
    const service = serperService();

    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM, 2));
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM, 3)).catch(() => undefined);

    const lines = logs();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      `documento=${DOCUMENT_ID} item=${ITEM_ID} pagina=2 status=200 duracao=1500ms`,
    );
    expect(lines[1]).toContain(
      `documento=${DOCUMENT_ID} item=${ITEM_ID} pagina=3 status=500 duracao=0ms`,
    );
    for (const line of lines) {
      expect(line).not.toContain('COXÃO');
      expect(line.toLowerCase()).not.toContain('coxão mole');
      expect(line).not.toContain(TEST_SERPER_KEY);
    }
  });

  it('a resposta guardada e a recusa por teto não deixam linha de busca paga', async () => {
    const logs = captureLogs();
    const { port } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port, config: { maxPerHour: 1 } });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM));
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM));
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('outro termo')).catch(() => undefined);

    expect(logs()).toHaveLength(1);
  });

  it('a chave de teste fica fora de toda linha de log e de todo corpo de resposta nas falhas 401, 402, 500 e prazo', async () => {
    const logs = captureLogs();
    fetchSpy.mockResolvedValueOnce(jsonReply('{"message":"Unauthorized"}', 401));
    fetchSpy.mockResolvedValueOnce(jsonReply('{"message":"Payment required"}', 402));
    fetchSpy.mockResolvedValueOnce(jsonReply('', 500));
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const service = serperService();
    const bodies: string[] = [];

    for (const n of [1, 2, 3, 4]) {
      const pending = service
        .search(DOCUMENT_ID, ITEM_ID, bodyOf(`falha ${n}`))
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(10_000);
      const error = (await pending) as HttpException;
      bodies.push(JSON.stringify(error.getResponse()) + error.message);
    }

    expect(logs()).toHaveLength(4);
    expect(logs().join('\n')).not.toContain(TEST_SERPER_KEY);
    expect(bodies.join('\n')).not.toContain(TEST_SERPER_KEY);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
