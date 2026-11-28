import { captureLogs } from '../providers/flyer-pro-photo-search.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  fakePhotoPort,
  ITEM_ID,
  makePhotoSearchService,
  OTHER_ITEM_ID,
  photo,
  tenPhotos,
} from './flyer-pro-photo-search.service.testutil';

const START = new Date('2026-11-28T10:00:00Z');
const HOUR = 3_600_000;

describe('FlyerProPhotoSearchService: resultados aproveitáveis e fim da busca', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    captureLogs();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('resultado sem endereço que sirva sai: 10 da Serper, um sem imageUrl e um data: viram 8', async () => {
    const results = [
      ...tenPhotos().slice(0, 8),
      photo(9, { imageUrl: '' }),
      photo(10, { imageUrl: 'data:image/png;base64,AAAA' }),
    ];
    const { service } = makePhotoSearchService({ port: fakePhotoPort(results).port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

    expect(view.results).toHaveLength(8);
    expect(view.results.map((r) => r.title)).toEqual(
      tenPhotos()
        .slice(0, 8)
        .map((p) => p.title),
    );
  });

  it('repetidos da página anterior saem: a página 2 com 3 dos mesmos endereços traz os 7 novos', async () => {
    const pages = [tenPhotos(1), [...tenPhotos(8).slice(0, 3), ...tenPhotos(21).slice(0, 7)]];
    const { port } = fakePhotoPort(() => Promise.resolve(pages.shift() ?? []));
    const { service } = makePhotoSearchService({ port });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 1));

    const second = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 2));

    expect(second.results).toHaveLength(7);
    expect(second.results.map((r) => r.title)).toEqual(
      tenPhotos(21)
        .slice(0, 7)
        .map((p) => p.title),
    );
  });

  it('o filtro de repetidos é do item e do termo: outro termo ou outro item não filtra', async () => {
    const { port } = fakePhotoPort(() => Promise.resolve(tenPhotos()));
    const { service } = makePhotoSearchService({ port });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 1));

    const otherTerm = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('y', 2));
    const otherItem = await service.search(DOCUMENT_ID, OTHER_ITEM_ID, bodyOf('x', 2));

    expect(otherTerm.results).toHaveLength(10);
    expect(otherItem.results).toHaveLength(10);
  });

  it('a página anterior vencida não filtra mais (A-29)', async () => {
    const { port } = fakePhotoPort(() => Promise.resolve(tenPhotos()));
    const { service } = makePhotoSearchService({ port });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 1));
    jest.advanceTimersByTime(25 * HOUR);

    const second = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 2));

    expect(second.results).toHaveLength(10);
  });

  it('página vazia: results [] e hasMore falso', async () => {
    const { service } = makePhotoSearchService({ port: fakePhotoPort([]).port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 3));

    expect(view).toMatchObject({ results: [], hasMore: false });
  });

  it('página só com repetidos não tem resultado novo: hasMore falso', async () => {
    const { port } = fakePhotoPort(() => Promise.resolve(tenPhotos()));
    const { service } = makePhotoSearchService({ port });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 1));

    const second = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 2));

    expect(second).toMatchObject({ results: [], hasMore: false });
  });

  it('a última página permitida (10) com 10 resultados novos traz hasMore falso; a 9 traz verdadeiro', async () => {
    const pages = [tenPhotos(1), tenPhotos(21)];
    const { port } = fakePhotoPort(() => Promise.resolve(pages.shift() ?? []));
    const { service } = makePhotoSearchService({ port });

    const nine = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 9));
    const ten = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 10));

    expect(nine.hasMore).toBe(true);
    expect(ten).toMatchObject({ hasMore: false, page: 10 });
    expect(ten.results).toHaveLength(10);
  });
});

describe('FlyerProPhotoSearchService: pedidos iguais ao mesmo tempo', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    captureLogs();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('clique duplo no Ver mais: uma busca só sai e os dois recebem os mesmos resultados', async () => {
    let release!: (results: ReturnType<typeof tenPhotos>) => void;
    const { port, search } = fakePhotoPort(() => new Promise((resolve) => (release = resolve)));
    const { service } = makePhotoSearchService({ port });

    const first = service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG', 2));
    await jest.advanceTimersByTimeAsync(50);
    const second = service.search(DOCUMENT_ID, ITEM_ID, bodyOf('coxão mole  bife kg', 2));
    release(tenPhotos());
    const [a, b] = await Promise.all([first, second]);

    expect(search).toHaveBeenCalledTimes(1);
    expect(b.results).toEqual(a.results);
    expect(a.results).toHaveLength(10);
  });

  it('a página já respondida vem da guardada: o terceiro pedido não chama', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port });
    await Promise.all([
      service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 2)),
      service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 2)),
    ]);

    const third = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x', 2));

    expect(third.fromCache).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
