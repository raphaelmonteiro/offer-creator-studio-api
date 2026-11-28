import { SerperPhotoSearch } from './flyer-pro-photo-search.serper';
import {
  captureLogs,
  jsonReply,
  serperImage,
  TEST_SERPER_KEY,
} from './flyer-pro-photo-search.testutil';

const SEARCH_URL = 'https://google.serper.dev/images';

describe('SerperPhotoSearch: a busca', () => {
  let fetchSpy: jest.SpyInstance;
  const provider = new SerperPhotoSearch(TEST_SERPER_KEY);
  const query = { term: 'BATATA DOCE ROXA KG', page: 2 };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('o pedido que sai', () => {
    it('POST em /images com a chave só no cabeçalho e país, idioma, quantidade e página fixados', async () => {
      fetchSpy.mockResolvedValue(jsonReply({ images: [serperImage()] }));

      await provider.search(query);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(SEARCH_URL);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'X-API-KEY': TEST_SERPER_KEY,
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        q: 'BATATA DOCE ROXA KG',
        gl: 'br',
        hl: 'pt-br',
        num: 10,
        page: 2,
      });
      expect(url).not.toContain(TEST_SERPER_KEY);
      expect(init.body).not.toContain(TEST_SERPER_KEY);
    });

    it('a resposta vira a forma do contrato, na ordem da Serper', async () => {
      fetchSpy.mockResolvedValue(
        jsonReply({
          images: [
            serperImage(),
            serperImage({
              imageUrl: 'https://atacadao.com.br/b.jpg',
              domain: 'atacadao.com.br',
              title: '',
            }),
          ],
        }),
      );

      await expect(provider.search(query)).resolves.toEqual([
        {
          imageUrl: 'https://www.extrabom.com.br/img/coxao-mole.jpg',
          thumbnailUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:abc',
          width: 1000,
          height: 1000,
          domain: 'extrabom.com.br',
          title: 'Coxão Mole Bovino Bife Resfriado kg',
        },
        expect.objectContaining({ imageUrl: 'https://atacadao.com.br/b.jpg', title: '' }),
      ]);
    });
  });

  describe('resposta tolerante: só o imageUrl é obrigatório', () => {
    const only = (over: Record<string, unknown>) => {
      fetchSpy.mockResolvedValue(jsonReply({ images: [over] }));
      return provider.search(query).then(([first]) => first);
    };

    it('sem imageWidth ou sem imageHeight, os dois tamanhos vão null (A-25)', async () => {
      const base = { imageUrl: 'https://atacadao.com.br/b.jpg' };

      for (const sizes of [{ imageWidth: 800 }, { imageHeight: 800 }, {}]) {
        expect(await only({ ...base, ...sizes })).toMatchObject({ width: null, height: null });
      }
    });

    it('tamanho que não é inteiro positivo vale ausente', async () => {
      const base = { imageUrl: 'https://atacadao.com.br/b.jpg' };

      for (const sizes of [
        { imageWidth: '800', imageHeight: 800 },
        { imageWidth: 0, imageHeight: 800 },
      ]) {
        expect(await only({ ...base, ...sizes })).toMatchObject({ width: null, height: null });
      }
    });

    it('sem domain vai o host do imageUrl, sem title vai vazio e sem thumbnailUrl vai null (A-30)', async () => {
      expect(await only({ imageUrl: 'https://www.atacadao.com.br/img/b.jpg' })).toEqual({
        imageUrl: 'https://www.atacadao.com.br/img/b.jpg',
        thumbnailUrl: null,
        width: null,
        height: null,
        domain: 'www.atacadao.com.br',
        title: '',
      });
    });

    it('o item sem imageUrl sai da lista, e o resto da página fica', async () => {
      fetchSpy.mockResolvedValue(
        jsonReply({
          images: [serperImage(), { title: 'sem endereço' }, 'texto', null, serperImage()],
        }),
      );

      expect(await provider.search(query)).toHaveLength(2);
    });

    it('página sem resultado é lista vazia, sem aviso', async () => {
      const logs = captureLogs();
      fetchSpy.mockResolvedValue(jsonReply({ images: [] }));

      expect(await provider.search(query)).toEqual([]);
      expect(logs()).toEqual([]);
    });

    it.each([
      ['objeto vazio', {}],
      ['objeto só com os créditos', { credits: 1, searchParameters: { q: 'x' } }],
    ])(
      'resposta 200 %s, sem a lista images, é página vazia com um aviso sem o termo e sem a chave (D-orq-268)',
      async (_name, body) => {
        const logs = captureLogs();
        fetchSpy.mockResolvedValue(jsonReply(body));

        await expect(provider.search(query)).resolves.toEqual([]);

        expect(logs()).toEqual(['Busca de fotos no Google: resposta sem a lista images']);
        expect(logs().join('\n')).not.toContain(TEST_SERPER_KEY);
        expect(logs().join('\n')).not.toContain(query.term);
      },
    );
  });
});
