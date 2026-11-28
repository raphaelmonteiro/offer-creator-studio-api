import * as sharp from 'sharp';
import { ImageSize, orientedSize } from './image-size';
import { MAX_INPUT_PIXELS } from './max-input-pixels';

/** Os formatos que o servidor aceita pelo conteúdo; SVG, HEIC e o resto o sharp lê ou não, mas a lista os recusa. */
export const READABLE_FORMATS = ['jpeg', 'png', 'webp', 'gif'] as const;
export type ReadableFormat = (typeof READABLE_FORMATS)[number];

export interface ReadImage extends ImageSize {
  format: ReadableFormat;
}

const isReadable = (format: string | undefined): format is ReadableFormat =>
  (READABLE_FORMATS as readonly string[]).includes(format ?? '');

/**
 * Lê a imagem pelo conteúdo, qualquer que seja o `content-type`: formato, medida com a orientação aplicada e uma passada de
 * decodificação (o `metadata()` aceita JPEG e PNG cortados no meio, que só a decodificação reprova), com o teto de
 * `MAX_INPUT_PIXELS`. GIF é medido no primeiro quadro. `null` para o que não é imagem aceita, corrompido ou grande demais.
 */
export async function readImage(buffer: Buffer): Promise<ReadImage | null> {
  try {
    const options = { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true };
    const metadata = await sharp(buffer, options).metadata();
    const size = orientedSize(metadata);
    if (!size || !isReadable(metadata.format)) return null;
    await sharp(buffer, options).resize(16, 16, { fit: 'inside' }).raw().toBuffer();
    return { format: metadata.format, ...size };
  } catch {
    return null;
  }
}
