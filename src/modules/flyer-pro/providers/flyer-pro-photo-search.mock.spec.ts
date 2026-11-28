import * as sharp from 'sharp';
import { SafeDownloadError } from '../../../shared/http/safe-download-error';
import { isGoogleGotoLink } from '../domain/flyer-pro-photo-link';
import { MockFlyerProPhotoSearch } from './flyer-pro-photo-search.mock';
import { PhotoLinkResolveFailure } from './flyer-pro-photo-search.port';

describe('MockFlyerProPhotoSearch: o provedor simulado, sem rede', () => {
  let fetchSpy: jest.SpyInstance;
  const mock = new MockFlyerProPhotoSearch();

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('nunca depende de chave nem faz requisição', async () => {
    const [first] = await mock.search({ term: 'ACÉM COM OSSO KG', page: 1 });
    await mock.fetchPhoto(
      await mock.resolveLink((await mock.search({ term: 'x', page: 1 }))[3].imageUrl),
    );

    expect(first).toBeDefined();
    expect(mock.source).toBe('mock');
    expect(mock.unavailableReason()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('10 resultados fixos por termo e página: o mesmo pedido responde sempre o mesmo', async () => {
    const query = { term: 'ACÉM COM OSSO KG', page: 1 };

    const first = await mock.search(query);
    const again = await new MockFlyerProPhotoSearch().search(query);

    expect(first).toHaveLength(10);
    expect(again).toEqual(first);
  });

  it('termo e página diferentes dão endereços diferentes, e nenhum se repete dentro da página', async () => {
    const urls = async (term: string, page: number) =>
      (await mock.search({ term, page })).map((result) => result.imageUrl);

    const page1 = await urls('ACÉM COM OSSO KG', 1);

    expect(new Set(page1).size).toBe(10);
    expect(await urls('ACÉM COM OSSO KG', 2)).not.toEqual(page1);
    expect(await urls('BATATA DOCE ROXA KG', 1)).not.toEqual(page1);
  });

  it('um resultado de 240 x 240, um sem tamanho e um link do Google (A-26)', async () => {
    const results = await mock.search({ term: 'ACÉM COM OSSO KG', page: 1 });

    expect(results.filter((r) => r.width === 240 && r.height === 240)).toHaveLength(1);
    expect(results.filter((r) => r.width === null && r.height === null)).toHaveLength(1);
    expect(results.filter((r) => isGoogleGotoLink(r.imageUrl))).toHaveLength(1);
    expect(results.every((r) => r.domain && r.title && r.thumbnailUrl)).toBe(true);
  });

  it('o link do Google se resolve sem rede para o endereço da foto, e outro link é recusado', async () => {
    const results = await mock.search({ term: 'ACÉM COM OSSO KG', page: 1 });
    const goto = results.find((r) => isGoogleGotoLink(r.imageUrl));

    const resolved = await mock.resolveLink(goto?.imageUrl ?? '');

    expect(resolved).toMatch(/^https:\/\/mock-photos\.invalid\/acem-com-osso-kg\/p1\/\d+\.jpg$/);
    expect(resolved).not.toBe(goto?.imageUrl);
    await expect(mock.resolveLink('https://www.google.com/goto?url=CAES')).rejects.toBeInstanceOf(
      PhotoLinkResolveFailure,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('o download gera uma foto de verdade, com o tamanho do resultado (o sem tamanho tem 240 x 240)', async () => {
    const results = await mock.search({ term: 'ACÉM COM OSSO KG', page: 1 });
    const direct = results.filter((r) => !isGoogleGotoLink(r.imageUrl));
    const small = direct.find((r) => r.width === 240);
    const unsized = direct.find((r) => r.width === null);
    const normal = direct.find((r) => r.width === 1000);

    for (const [result, side] of [
      [small, 240],
      [unsized, 240],
      [normal, 1000],
    ] as const) {
      const photo = await mock.fetchPhoto(result?.imageUrl ?? '');
      const meta = await sharp(photo.buffer).metadata();

      expect([photo.width, photo.height]).toEqual([side, side]);
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', side, side]);
      expect([photo.format, photo.extension, photo.mimeType]).toEqual([
        'jpeg',
        '.jpg',
        'image/jpeg',
      ]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('endereço que não é do simulado é recusado, sem conexão', async () => {
    await expect(mock.fetchPhoto('https://www.extrabom.com.br/img/x.jpg')).rejects.toMatchObject({
      constructor: SafeDownloadError,
      reason: 'NETWORK',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
