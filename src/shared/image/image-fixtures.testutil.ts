import * as sharp from 'sharp';

/** Imagens reais geradas pelo sharp para os testes de download e de leitura (nada de bytes soltos que o sharp não decodifica). */

/** Pixels cinza de `width` × `height`, 1 canal: o PNG sai pequeno mesmo com milhões de pixels. */
const grayPixels = (width: number, height: number) =>
  sharp(Buffer.alloc(width * height, 128), { raw: { width, height, channels: 1 } });

/** JPEG de verdade, com a orientação do EXIF quando pedida. */
export async function jpegOf(
  width: number,
  height: number,
  options: { orientation?: number } = {},
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: '#cc3322' },
  }).jpeg({ quality: 70 });
  return (
    options.orientation ? pipeline.withMetadata({ orientation: options.orientation }) : pipeline
  ).toBuffer();
}

export const pngOf = (width: number, height: number): Promise<Buffer> =>
  grayPixels(width, height).png().toBuffer();

export const webpOf = (width: number, height: number): Promise<Buffer> =>
  grayPixels(width, height).webp().toBuffer();

/** GIF de dois quadros: a medida é a do primeiro. */
export async function animatedGifOf(width: number, height: number): Promise<Buffer> {
  const frame = (background: string) =>
    sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toBuffer();
  const frames = [await frame('#ff0000'), await frame('#0000ff')];
  return sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer();
}

/** O mesmo arquivo cortado no meio: o cabeçalho (formato, largura e altura) fica legível, mas não decodifica. */
export const cutInHalf = (image: Buffer): Buffer => image.subarray(0, Math.floor(image.length / 2));

/** Texto no lugar da imagem (página HTML, SVG): o sharp não o lê como JPEG, PNG, WebP ou GIF. */
export const textBytes = (text: string): Buffer => Buffer.from(text, 'utf8');

/** `size` bytes exatos: a imagem seguida de zeros (o lixo depois do fim do arquivo não impede a decodificação). */
export function paddedTo(image: Buffer, size: number): Buffer {
  if (image.length > size) throw new Error('imagem maior que o tamanho pedido');
  return Buffer.concat([image, Buffer.alloc(size - image.length)]);
}
