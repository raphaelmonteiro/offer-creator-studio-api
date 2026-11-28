import * as sharp from 'sharp';

export interface ImageSize {
  width: number;
  height: number;
}

/** A medida do cabeçalho (arquivo ou bytes) com a orientação do arquivo aplicada; `null` se não é imagem. */
export async function sizeOf(input: string | Buffer): Promise<ImageSize | null> {
  try {
    const { width, height, orientation } = await sharp(input).metadata();
    if (!width || !height) return null;
    // EXIF 5 a 8: a imagem é exibida girada em 90 graus, e a proporção que o card usa é a da exibição.
    return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
  } catch {
    return null;
  }
}
