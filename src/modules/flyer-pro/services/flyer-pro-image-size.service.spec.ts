import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import { FlyerProImageSizeService } from './flyer-pro-image-size.service';

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'flyer-pro-image-size-'));
afterAll(() => fs.rmSync(uploads, { recursive: true, force: true }));

const service = new FlyerProImageSizeService(fakeConfig({ UPLOAD_DEST: uploads }));

/** Grava uma imagem de teste em `gallery/` do `UPLOAD_DEST` e devolve a URL como a Galeria a guarda. */
async function writePhoto(name: string, width: number, height: number, orientation?: number) {
  fs.mkdirSync(path.join(uploads, 'gallery'), { recursive: true });
  const image = sharp({ create: { width, height, channels: 3, background: '#cc0000' } }).jpeg();
  await (orientation ? image.withMetadata({ orientation }) : image).toFile(
    path.join(uploads, 'gallery', name),
  );
  return `http://localhost:3101/uploads/gallery/${name}`;
}

describe('FlyerProImageSizeService', () => {
  it('lê a largura e a altura do arquivo local: a garrafa em pé de 600×1200', async () => {
    const url = await writePhoto('coca-cola-2l.jpg', 600, 1200);

    expect(await service.measure(url)).toEqual({ width: 600, height: 1200 });
  });

  it('a URL relativa e a de outro endereço do mesmo /uploads/ achem o mesmo arquivo', async () => {
    await writePhoto('abacate.jpg', 800, 400);

    expect(await service.measure('/uploads/gallery/abacate.jpg')).toEqual({
      width: 800,
      height: 400,
    });
    expect(
      await service.measure('https://cdn.exemplo.com/uploads/gallery/abacate.jpg?v=2'),
    ).toEqual({
      width: 800,
      height: 400,
    });
  });

  it('foto girada pelo EXIF (orientação 6): a proporção é a da exibição', async () => {
    const url = await writePhoto('girada.jpg', 400, 100, 6);

    expect(await service.measure(url)).toEqual({ width: 100, height: 400 });
  });

  it('arquivo que não existe: null', async () => {
    expect(await service.measure('http://localhost:3101/uploads/gallery/apagada.jpg')).toBeNull();
  });

  it('arquivo que não é imagem: null, sem lançar', async () => {
    fs.mkdirSync(path.join(uploads, 'gallery'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'gallery', 'quebrada.jpg'), 'isto não é uma imagem');

    expect(await service.measure('/uploads/gallery/quebrada.jpg')).toBeNull();
  });

  it.each([
    ['URL sem /uploads/', 'http://localhost:3101/gallery/coca-cola-2l.jpg'],
    ['caminho que escapa do UPLOAD_DEST', '/uploads/../../etc/passwd'],
    ['caminho escapando por %2e%2e', '/uploads/%2e%2e/%2e%2e/etc/passwd'],
    ['URL vazia', ''],
    ['só a pasta', '/uploads/'],
  ])('%s: null', async (_, url) => {
    expect(await service.measure(url)).toBeNull();
  });
});
