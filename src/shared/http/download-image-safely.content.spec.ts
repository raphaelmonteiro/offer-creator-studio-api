import {
  animatedGifOf,
  cutInHalf,
  jpegOf,
  pngOf,
  textBytes,
  webpOf,
} from '../image/image-fixtures.testutil';
import { downloadImageSafely } from './download-image-safely';
import { fetchFrom, imageResponse } from './download-image-safely.testutil';

const URL_OF = 'https://www.extrabom.com.br/img/x.jpg';

const download = (body: Buffer, headers?: Record<string, string>) =>
  downloadImageSafely(URL_OF, { fetch: fetchFrom({ [URL_OF]: imageResponse(body, headers) }) });

/** HEIC mínimo: o cabeçalho `ftyp heic`, que o sharp pré-compilado não decodifica. */
const HEIC = Buffer.from('0000001c6674797068656963000000006d696631686569636d696166', 'hex');

describe('downloadImageSafely: conteúdo que é imagem de verdade', () => {
  it('Página com cabeçalho de imagem: HTML com content-type image/jpeg é NOT_AN_IMAGE', async () => {
    await expect(
      download(textBytes('<html><body>Acesso negado</body></html>'), {
        'content-type': 'image/jpeg',
      }),
    ).rejects.toMatchObject({ reason: 'NOT_AN_IMAGE' });
  });

  it('SVG e HEIC: os dois são NOT_AN_IMAGE, qualquer que seja o content-type', async () => {
    const svg = textBytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

    await expect(download(svg, { 'content-type': 'image/svg+xml' })).rejects.toMatchObject({
      reason: 'NOT_AN_IMAGE',
    });
    await expect(download(HEIC, { 'content-type': 'image/heic' })).rejects.toMatchObject({
      reason: 'NOT_AN_IMAGE',
    });
  });

  it('Imagem de verdade com cabeçalho errado: um PNG com octet-stream é gravado como .png, image/png', async () => {
    const png = await pngOf(64, 48);

    const image = await download(png, { 'content-type': 'application/octet-stream' });

    expect(image).toMatchObject({
      format: 'png',
      extension: '.png',
      mimeType: 'image/png',
      width: 64,
      height: 48,
    });
  });

  it('um JPEG servido como image/png continua JPEG: o tipo vem do conteúdo', async () => {
    const image = await download(await jpegOf(20, 10), { 'content-type': 'image/png' });

    expect(image).toMatchObject({ format: 'jpeg', extension: '.jpg', mimeType: 'image/jpeg' });
  });

  it('WebP e GIF são aceitos, com a extensão e o tipo do formato', async () => {
    expect(await download(await webpOf(32, 16))).toMatchObject({
      format: 'webp',
      extension: '.webp',
      mimeType: 'image/webp',
      width: 32,
      height: 16,
    });
    expect(await download(await animatedGifOf(24, 12))).toMatchObject({
      format: 'gif',
      extension: '.gif',
      mimeType: 'image/gif',
    });
  });

  it('GIF animado: gravado como veio (os bytes são os da origem) e medido no primeiro quadro', async () => {
    const gif = await animatedGifOf(24, 12);

    const image = await download(gif);

    expect(image.buffer.equals(gif)).toBe(true);
    expect([image.width, image.height]).toEqual([24, 12]);
  });

  it('a medida leva a orientação do arquivo: JPEG 1200 × 900 com orientação 6 mede 900 × 1200', async () => {
    const image = await download(await jpegOf(1200, 900, { orientation: 6 }));

    expect([image.width, image.height]).toEqual([900, 1200]);
  });

  it('Arquivo cortado: JPEG e PNG com o cabeçalho inteiro e a metade dos bytes são NOT_AN_IMAGE', async () => {
    const jpeg = await jpegOf(800, 600);
    const png = await pngOf(800, 600);

    await expect(download(cutInHalf(jpeg))).rejects.toMatchObject({ reason: 'NOT_AN_IMAGE' });
    await expect(download(cutInHalf(png))).rejects.toMatchObject({ reason: 'NOT_AN_IMAGE' });
  });

  it('corpo vazio: NOT_AN_IMAGE', async () => {
    await expect(download(Buffer.alloc(0))).rejects.toMatchObject({ reason: 'NOT_AN_IMAGE' });
  });

  it('Imagem acima do teto de pixels: 7000 × 7000 (49 milhões) é NOT_AN_IMAGE, e 8000 × 5000 (40 milhões) é gravado', async () => {
    const tooBig = await pngOf(7000, 7000);
    const atTheCeiling = await pngOf(8000, 5000);

    await expect(download(tooBig)).rejects.toMatchObject({ reason: 'NOT_AN_IMAGE' });
    await expect(download(atTheCeiling)).resolves.toMatchObject({ width: 8000, height: 5000 });
  }, 30_000);
});
