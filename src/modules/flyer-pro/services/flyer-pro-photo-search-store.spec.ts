import type { PhotoSearchResult } from '../providers/flyer-pro-photo-search.port';
import {
  FlyerProPhotoSearchStore,
  PHOTO_SEARCH_MAX_PAGES,
  type PhotoPageScope,
} from './flyer-pro-photo-search-store';

const DOC = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
const OTHER_DOC = '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44';
const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = new Date('2026-11-28T10:00:00Z');

const scopeOf = (over: Partial<PhotoPageScope> = {}): PhotoPageScope => ({
  documentId: DOC,
  itemId: ITEM_A,
  term: 'COXÃO MOLE BIFE KG',
  page: 1,
  ...over,
});

const result = (n: number): PhotoSearchResult => ({
  imageUrl: `https://www.extrabom.com.br/img/${n}.jpg`,
  thumbnailUrl: null,
  width: 1000,
  height: 1000,
  domain: 'extrabom.com.br',
  title: '',
});

const pageOf = (...numbers: number[]) => ({ hasMore: true, results: numbers.map(result) });

/** Guarda `count` páginas de itens diferentes, a primeira com o item `first`. */
function fill(store: FlyerProPhotoSearchStore, count: number, first?: PhotoPageScope): void {
  if (first) store.write(first, pageOf(1, 2, 3));
  for (let i = first ? 1 : 0; i < count; i++) {
    store.write(scopeOf({ itemId: `item-${i}` }), pageOf(i));
  }
}

describe('FlyerProPhotoSearchStore: resposta guardada por item e termo', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('o mesmo pedido dentro de 24 horas lê a mesma página, com os mesmos resultId', () => {
    const store = new FlyerProPhotoSearchStore();
    const written = store.write(scopeOf(), pageOf(1, 2));
    jest.advanceTimersByTime(2 * HOUR);

    expect(store.read(scopeOf())).toEqual(written);
    expect(store.read(scopeOf())?.results.map((r) => r.imageUrl)).toEqual([
      'https://www.extrabom.com.br/img/1.jpg',
      'https://www.extrabom.com.br/img/2.jpg',
    ]);
  });

  it('a página nunca buscada, ou de outra página, não está guardada', () => {
    const store = new FlyerProPhotoSearchStore();

    expect(store.read(scopeOf())).toBeNull();
    store.write(scopeOf(), pageOf(1));
    expect(store.read(scopeOf({ page: 2 }))).toBeNull();
  });

  it('o termo da chave é aparado, com os espaços juntos e sem distinção de caixa', () => {
    const store = new FlyerProPhotoSearchStore();
    store.write(scopeOf(), pageOf(1));

    expect(store.read(scopeOf({ term: '  coxão   mole bife kg ' }))).not.toBeNull();
    expect(store.read(scopeOf({ term: 'coxão mole friboi' }))).toBeNull();
  });

  it('a resposta guardada é do encarte e do item', () => {
    const store = new FlyerProPhotoSearchStore();
    store.write(scopeOf(), pageOf(1));

    expect(store.read(scopeOf({ itemId: ITEM_B }))).toBeNull();
    expect(store.read(scopeOf({ documentId: OTHER_DOC }))).toBeNull();
  });

  it('depois de 24 horas e 1 minuto a página vale vencida; aos 24 horas menos 1 ms ainda vale', () => {
    const store = new FlyerProPhotoSearchStore();
    store.write(scopeOf(), pageOf(1));

    jest.advanceTimersByTime(24 * HOUR - 1);
    expect(store.read(scopeOf())).not.toBeNull();
    jest.advanceTimersByTime(1 + MINUTE);

    expect(store.read(scopeOf())).toBeNull();
  });

  it('a API reiniciada (um store novo) não tem a página', () => {
    const before = new FlyerProPhotoSearchStore();
    before.write(scopeOf(), pageOf(1));

    expect(new FlyerProPhotoSearchStore().read(scopeOf())).toBeNull();
  });
});

describe('FlyerProPhotoSearchStore: resultId', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const idsOf = (page: { results: { resultId: string }[] }) => page.results.map((r) => r.resultId);

  it('r<n> com n crescente, começando no instante da subida, entre termos e páginas do item', () => {
    const store = new FlyerProPhotoSearchStore();
    const first = idsOf(store.write(scopeOf(), pageOf(1, 2, 3)));
    const second = idsOf(store.write(scopeOf({ page: 2 }), pageOf(4)));
    const third = idsOf(store.write(scopeOf({ term: 'coxão mole friboi' }), pageOf(5)));

    const start = START.getTime();
    expect(first).toEqual([`r${start + 1}`, `r${start + 2}`, `r${start + 3}`]);
    expect([...second, ...third]).toEqual([`r${start + 4}`, `r${start + 5}`]);
    expect(first.join().length).toBeLessThan(64 * 3);
  });

  it('a página vencida e gravada de novo ganha ids novos: nenhum repete depois de vencer', () => {
    const store = new FlyerProPhotoSearchStore();
    const old = idsOf(store.write(scopeOf(), pageOf(1, 2)));
    jest.advanceTimersByTime(25 * HOUR);

    const fresh = idsOf(store.write(scopeOf(), pageOf(1, 2)));

    expect(fresh.filter((id) => old.includes(id))).toEqual([]);
    expect(store.findResult(DOC, ITEM_A, old[0])).toBeNull();
  });

  it('depois do reinício o contador recomeça no instante novo, e o id de antes não é achado', () => {
    const before = new FlyerProPhotoSearchStore();
    const [oldId] = idsOf(before.write(scopeOf(), pageOf(1, 2, 3)));
    jest.advanceTimersByTime(5 * MINUTE);

    const after = new FlyerProPhotoSearchStore();
    const fresh = idsOf(after.write(scopeOf({ term: 'coxão mole friboi' }), pageOf(1, 2, 3)));

    expect(fresh).not.toContain(oldId);
    expect(after.findResult(DOC, ITEM_A, oldId)).toBeNull();
  });
});

describe('FlyerProPhotoSearchStore: download só de resultado guardado do item', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('acha o resultado do item pelo resultId, em qualquer termo e página ainda guardados', () => {
    const store = new FlyerProPhotoSearchStore();
    const [r1] = store.write(scopeOf(), pageOf(1, 2)).results;
    const [r9] = store.write(scopeOf({ term: 'coxão mole friboi' }), pageOf(9)).results;

    expect(store.findResult(DOC, ITEM_A, r1.resultId)).toEqual(r1);
    expect(store.findResult(DOC, ITEM_A, r9.resultId)).toEqual(r9);
  });

  it('o resultId de outro item, de outro encarte, vencido ou inventado não é achado', () => {
    const store = new FlyerProPhotoSearchStore();
    const [r1] = store.write(scopeOf(), pageOf(1)).results;

    expect(store.findResult(DOC, ITEM_B, r1.resultId)).toBeNull();
    expect(store.findResult(OTHER_DOC, ITEM_A, r1.resultId)).toBeNull();
    expect(store.findResult(DOC, ITEM_A, 'r3')).toBeNull();
    jest.advanceTimersByTime(25 * HOUR);
    expect(store.findResult(DOC, ITEM_A, r1.resultId)).toBeNull();
  });
});

describe('FlyerProPhotoSearchStore: repetidos só contra as páginas anteriores ainda guardadas (A-29)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('devolve os imageUrl das páginas de número menor, do mesmo item e termo', () => {
    const store = new FlyerProPhotoSearchStore();
    store.write(scopeOf({ page: 1 }), pageOf(1, 2));
    store.write(scopeOf({ page: 2 }), pageOf(3));
    store.write(scopeOf({ page: 3 }), pageOf(4));
    store.write(scopeOf({ term: 'outro termo', page: 1 }), pageOf(7));
    store.write(scopeOf({ itemId: ITEM_B, page: 1 }), pageOf(8));

    expect(
      [...store.previousUrls(scopeOf({ page: 3, term: ' COXÃO  mole bife KG' }))].sort(),
    ).toEqual([
      'https://www.extrabom.com.br/img/1.jpg',
      'https://www.extrabom.com.br/img/2.jpg',
      'https://www.extrabom.com.br/img/3.jpg',
    ]);
    expect(store.previousUrls(scopeOf({ page: 1 })).size).toBe(0);
  });

  it('a página anterior vencida não filtra mais', () => {
    const store = new FlyerProPhotoSearchStore();
    store.write(scopeOf({ page: 1 }), pageOf(1, 2));
    jest.advanceTimersByTime(25 * HOUR);

    expect(store.previousUrls(scopeOf({ page: 2 })).size).toBe(0);
  });
});

describe('FlyerProPhotoSearchStore: teto de 2.000 páginas', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('com a memória cheia sai a mais antiga, e a que saiu vale vencida (nem a leitura nem o resultId a acham)', () => {
    const store = new FlyerProPhotoSearchStore();
    const oldest = scopeOf();
    fill(store, PHOTO_SEARCH_MAX_PAGES, oldest);
    const [, , r3] = store.read(oldest)?.results ?? [];
    jest.advanceTimersByTime(MINUTE);

    store.write(scopeOf({ itemId: ITEM_B, term: 'ACÉM COM OSSO KG' }), pageOf(50));

    expect(store.read(oldest)).toBeNull();
    expect(store.findResult(DOC, ITEM_A, r3.resultId)).toBeNull();
    expect(store.read(scopeOf({ itemId: ITEM_B, term: 'ACÉM COM OSSO KG' }))).not.toBeNull();
    expect(store.read(scopeOf({ itemId: 'item-1' }))).not.toBeNull();
  });

  it('só a mais antiga sai: 2.001 gravações deixam 2.000 páginas', () => {
    const store = new FlyerProPhotoSearchStore();
    fill(store, PHOTO_SEARCH_MAX_PAGES + 1);

    expect(store.read(scopeOf({ itemId: 'item-0' }))).toBeNull();
    expect(store.read(scopeOf({ itemId: 'item-1' }))).not.toBeNull();
    expect(store.read(scopeOf({ itemId: `item-${PHOTO_SEARCH_MAX_PAGES}` }))).not.toBeNull();
  });

  it('a vencida sai antes da mais antiga válida', () => {
    const store = new FlyerProPhotoSearchStore();
    store.write(scopeOf({ itemId: 'item-vencida' }), pageOf(99));
    jest.advanceTimersByTime(2 * MINUTE);
    const oldestValid = scopeOf();
    fill(store, PHOTO_SEARCH_MAX_PAGES - 1, oldestValid);
    jest.advanceTimersByTime(24 * HOUR - MINUTE);
    expect(store.read(scopeOf({ itemId: 'item-vencida' }))).toBeNull();

    store.write(scopeOf({ itemId: ITEM_B }), pageOf(50));

    expect(store.read(oldestValid)).not.toBeNull();
    expect(store.read(scopeOf({ itemId: ITEM_B }))).not.toBeNull();
  });

  it('ao guardar com a memória cheia saem todas as vencidas, não só uma vaga', () => {
    const store = new FlyerProPhotoSearchStore();
    for (const name of ['v1', 'v2', 'v3']) store.write(scopeOf({ itemId: name }), pageOf(1));
    jest.advanceTimersByTime(25 * HOUR);
    fill(store, PHOTO_SEARCH_MAX_PAGES - 3);
    expect(store.pageCount).toBe(PHOTO_SEARCH_MAX_PAGES);

    store.write(scopeOf({ itemId: ITEM_B }), pageOf(50));

    expect(store.pageCount).toBe(PHOTO_SEARCH_MAX_PAGES - 3 + 1);
    expect(store.read(scopeOf({ itemId: 'item-0' }))).not.toBeNull();
  });

  it('reescrever uma página já guardada não gasta vaga nem expulsa outra', () => {
    const store = new FlyerProPhotoSearchStore();
    fill(store, PHOTO_SEARCH_MAX_PAGES);

    store.write(scopeOf({ itemId: 'item-5' }), pageOf(500));

    expect(store.read(scopeOf({ itemId: 'item-0' }))).not.toBeNull();
    expect(store.read(scopeOf({ itemId: 'item-5' }))?.results[0].imageUrl).toContain('/500.jpg');
  });
});

describe('FlyerProPhotoSearchStore: pedidos iguais no ar', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it('dois pedidos iguais viram uma execução só e recebem o mesmo resultado', async () => {
    const store = new FlyerProPhotoSearchStore();
    const gate = deferred<string>();
    const work = jest.fn(() => gate.promise);

    const first = store.joinInFlight(scopeOf({ page: 2 }), work);
    const second = store.joinInFlight(scopeOf({ page: 2, term: ' coxão mole  bife kg' }), work);
    gate.resolve('página 2');

    expect(await Promise.all([first, second])).toEqual(['página 2', 'página 2']);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('outra página, outro item ou outro termo não se juntam', async () => {
    const store = new FlyerProPhotoSearchStore();
    const work = jest.fn(() => Promise.resolve('x'));

    await Promise.all([
      store.joinInFlight(scopeOf({ page: 2 }), work),
      store.joinInFlight(scopeOf({ page: 3 }), work),
      store.joinInFlight(scopeOf({ page: 2, itemId: ITEM_B }), work),
      store.joinInFlight(scopeOf({ page: 2, term: 'outro' }), work),
    ]);

    expect(work).toHaveBeenCalledTimes(4);
  });

  it('terminado o pedido, o seguinte executa de novo; a falha chega aos dois e não fica', async () => {
    const store = new FlyerProPhotoSearchStore();
    const gate = deferred<string>();
    const failing = jest.fn(() => gate.promise);

    const first = store.joinInFlight(scopeOf(), failing).catch((e: unknown) => e);
    const second = store.joinInFlight(scopeOf(), failing).catch((e: unknown) => e);
    gate.reject(new Error('Serper fora do ar'));

    expect(await first).toEqual(new Error('Serper fora do ar'));
    expect(await second).toBe(await first);
    const later = jest.fn(() => Promise.resolve('de novo'));
    await expect(store.joinInFlight(scopeOf(), later)).resolves.toBe('de novo');
    expect(failing).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
