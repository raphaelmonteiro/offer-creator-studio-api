import { pngOf } from '../../shared/image/image-fixtures.testutil';
import {
  PIXABAY_PHOTO_URL,
  pixabayFetch,
  pixabayFile,
  pixabayMissing,
  pixabayPhoto,
} from '../ai/pixabay.testutil';
import { GalleryPhotoImportService } from './gallery-photo-import.service';

const IMAGE_URL = PIXABAY_PHOTO_URL;
const MB = 1024 * 1024;

function build(reply: Parameters<typeof pixabayFetch>[0]) {
  let next = 0;
  const uploads = {
    uploadFile: jest.fn(async (file: { originalname: string }) => ({
      id: `uuid-do-arquivo${file.originalname.slice(file.originalname.lastIndexOf('.'))}`,
      url: 'http://localhost:3101/uploads/products/salsinha-maco-1763143328000.jpg',
    })),
    deleteFile: jest.fn(async () => undefined),
  };
  const gallery = {
    registerImage: jest.fn(async () => ({ id: `gallery-image-${(next += 1)}` })),
  };
  const service = new GalleryPhotoImportService(uploads as never, gallery as never);
  const connection = pixabayFetch(reply);
  service.fetchImpl = connection.fetch;
  return { service, uploads, gallery, connection };
}

describe('GalleryPhotoImportService: devolve a URL e o id da foto da Galeria', () => {
  it('sucesso: { url, imageId } com o id da linha que registerImage criou', async () => {
    const photo = await pixabayPhoto(2048);
    const { service, uploads, gallery } = build(() => pixabayFile(photo));

    const result = await service.downloadAndRegister(IMAGE_URL, 'SALSINHA MAÇO');

    expect(result).toMatchObject({
      url: 'http://localhost:3101/uploads/products/salsinha-maco-1763143328000.jpg',
      imageId: 'gallery-image-1',
    });
    expect(uploads.uploadFile).toHaveBeenCalledWith(expect.anything(), 'products');
    expect(gallery.registerImage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/jpeg', size: 2048, url: result.url }),
    );
  });

  it('devolve a medida do arquivo gravado, para quem precisa de largura e altura', async () => {
    const photo = await pixabayPhoto();
    const { service } = build(() => pixabayFile(photo));

    expect(await service.downloadAndRegister(IMAGE_URL, 'SALSINHA')).toMatchObject({
      width: 64,
      height: 48,
    });
  });

  it('duas vezes o mesmo pedido: dois ids diferentes e duas linhas, como hoje', async () => {
    const photo = await pixabayPhoto();
    const { service, gallery } = build(() => pixabayFile(photo));

    const first = await service.downloadAndRegister(IMAGE_URL, 'SALSINHA MAÇO');
    const second = await service.downloadAndRegister(IMAGE_URL, 'SALSINHA MAÇO');

    expect(first.imageId).not.toEqual(second.imageId);
    expect(gallery.registerImage).toHaveBeenCalledTimes(2);
  });

  it('origem com status 404: lança e não grava arquivo nem linha', async () => {
    const { service, uploads, gallery } = build(() => pixabayMissing(404));

    await expect(service.downloadAndRegister(IMAGE_URL, 'SALSINHA MAÇO')).rejects.toThrow(
      'status 404',
    );

    expect(uploads.uploadFile).not.toHaveBeenCalled();
    expect(gallery.registerImage).not.toHaveBeenCalled();
  });

  it.each([
    ['declarado em content-length', 12 * MB, 12 * MB],
    ['sem content-length, pelo corpo lido', 12 * MB, undefined],
  ])('arquivo de 12 MB %s: lança e não grava arquivo nem linha', async (_name, bytes, length) => {
    const { service, uploads, gallery } = build(() =>
      pixabayFile(Buffer.alloc(bytes), { contentLength: length }),
    );

    await expect(service.downloadAndRegister(IMAGE_URL, 'SALSINHA MAÇO')).rejects.toThrow(
      'excede o limite de 10MB',
    );

    expect(uploads.uploadFile).not.toHaveBeenCalled();
    expect(gallery.registerImage).not.toHaveBeenCalled();
  });
});

describe('GalleryPhotoImportService: o que é gravado vem do conteúdo, e nada fica se o registro falha', () => {
  it('PNG servido como image/jpeg: extensão .png e tipo image/png no arquivo e na Galeria', async () => {
    const png = await pngOf(30, 20);
    const { service, uploads, gallery } = build(() =>
      pixabayFile(png, { contentType: 'image/jpeg' }),
    );

    await service.downloadAndRegister(IMAGE_URL, 'Pão Francês KG');

    const [file] = uploads.uploadFile.mock.calls[0] as unknown as [
      { originalname: string; mimetype: string },
    ];
    expect(file.originalname).toMatch(/^pao-frances-kg-\d+\.png$/);
    expect(file.mimetype).toBe('image/png');
    expect(gallery.registerImage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/png', filename: file.originalname }),
    );
  });

  it('Registro na Galeria que falha: apaga o arquivo gravado em uploads/products e repassa a falha', async () => {
    const photo = await pixabayPhoto();
    const { service, uploads, gallery } = build(() => pixabayFile(photo));
    gallery.registerImage.mockRejectedValue(new Error('banco fora do ar'));

    await expect(service.downloadAndRegister(IMAGE_URL, 'SALSINHA MAÇO')).rejects.toThrow(
      'banco fora do ar',
    );

    expect(uploads.uploadFile).toHaveBeenCalledTimes(1);
    expect(uploads.deleteFile).toHaveBeenCalledWith('products/uuid-do-arquivo.jpg');
  });

  it('a regra do chamador (allowUrl) recusa antes de qualquer conexão e nada é gravado', async () => {
    const { service, uploads, connection } = build(() => pixabayMissing(200));
    const allowUrl = jest.fn(() => false);

    await expect(
      service.downloadAndRegister('https://exemplo.com/x.jpg', 'SALSINHA', { allowUrl }),
    ).rejects.toMatchObject({ reason: 'SCHEME' });

    expect(connection.request).not.toHaveBeenCalled();
    expect(uploads.uploadFile).not.toHaveBeenCalled();
  });

  it('endereço interno: recusado sem conexão e sem gravar nada', async () => {
    const { service, uploads, connection } = build(() => pixabayMissing(200));

    await expect(
      service.downloadAndRegister('http://169.254.169.254/latest/meta-data/', 'SALSINHA'),
    ).rejects.toMatchObject({ reason: 'PRIVATE_ADDRESS' });

    expect(connection.request).not.toHaveBeenCalled();
    expect(uploads.uploadFile).not.toHaveBeenCalled();
  });
});
