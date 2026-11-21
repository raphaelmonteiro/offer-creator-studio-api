import { PixabayService } from './pixabay.service';
import { fetchWithTimeout } from './utils/fetch-with-timeout.util';
import { fakeConfig } from './utils/openai-chat.testutil';

jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

const fetchMock = fetchWithTimeout as unknown as jest.Mock;

const IMAGE_URL = 'https://pixabay.com/get/g1a2b3c4d5e6f_1280.jpg';
const MB = 1024 * 1024;

/** A resposta do Pixabay com o arquivo; `contentLength` só entra quando o teste o informa. */
function pixabayFile(bytes: number, contentLength?: number) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return 'image/jpeg';
        if (name === 'content-length' && contentLength !== undefined) return String(contentLength);
        return null;
      },
    },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

function build() {
  let next = 0;
  const uploads = {
    uploadFile: jest.fn(async () => ({
      url: 'http://localhost:3101/uploads/products/salsinha-maco-1763143328000.jpg',
    })),
  };
  const gallery = {
    registerImage: jest.fn(async () => ({ id: `gallery-image-${(next += 1)}` })),
  };
  const service = new PixabayService(
    fakeConfig({ PIXABAY_API_KEY: 'pk-teste' }),
    uploads as never,
    gallery as never,
  );
  return { service, uploads, gallery };
}

describe('PixabayService.downloadAndSaveImage: devolve a URL e o id da foto da Galeria', () => {
  beforeEach(() => fetchMock.mockReset());

  it('sucesso: { url, imageId } com o id da linha que registerImage criou', async () => {
    fetchMock.mockResolvedValue(pixabayFile(2048));
    const { service, uploads, gallery } = build();

    const result = await service.downloadAndSaveImage(IMAGE_URL, 'SALSINHA MAÇO');

    expect(result).toEqual({
      url: 'http://localhost:3101/uploads/products/salsinha-maco-1763143328000.jpg',
      imageId: 'gallery-image-1',
    });
    expect(uploads.uploadFile).toHaveBeenCalledWith(expect.anything(), 'products');
    expect(gallery.registerImage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/jpeg', size: 2048, url: result.url }),
    );
  });

  it('duas vezes o mesmo pedido: dois ids diferentes e duas linhas, como hoje', async () => {
    fetchMock.mockResolvedValue(pixabayFile(2048));
    const { service, gallery } = build();

    const first = await service.downloadAndSaveImage(IMAGE_URL, 'SALSINHA MAÇO');
    const second = await service.downloadAndSaveImage(IMAGE_URL, 'SALSINHA MAÇO');

    expect(first.imageId).not.toEqual(second.imageId);
    expect(gallery.registerImage).toHaveBeenCalledTimes(2);
  });

  it('origem com status 404: lança e não grava arquivo nem linha', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const { service, uploads, gallery } = build();

    await expect(service.downloadAndSaveImage(IMAGE_URL, 'SALSINHA MAÇO')).rejects.toThrow(
      'status 404',
    );

    expect(uploads.uploadFile).not.toHaveBeenCalled();
    expect(gallery.registerImage).not.toHaveBeenCalled();
  });

  it.each([
    ['declarado em content-length', 12 * MB, 12 * MB],
    ['sem content-length, pelo corpo lido', 12 * MB, undefined],
  ])('arquivo de 12 MB %s: lança e não grava arquivo nem linha', async (_name, bytes, length) => {
    fetchMock.mockResolvedValue(pixabayFile(bytes, length));
    const { service, uploads, gallery } = build();

    await expect(service.downloadAndSaveImage(IMAGE_URL, 'SALSINHA MAÇO')).rejects.toThrow(
      'excede o limite de 10MB',
    );

    expect(uploads.uploadFile).not.toHaveBeenCalled();
    expect(gallery.registerImage).not.toHaveBeenCalled();
  });
});
