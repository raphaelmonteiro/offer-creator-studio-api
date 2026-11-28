import * as sharp from 'sharp';

export interface ImageSize {
  width: number;
  height: number;
}

/** A medida do cabeçalho com a orientação do arquivo aplicada; `null` sem largura ou altura. */
export function orientedSize({ width, height, orientation }: sharp.Metadata): ImageSize | null {
  if (!width || !height) return null;
  // EXIF 5 a 8: a imagem é exibida girada em 90 graus, e a proporção que o card usa é a da exibição.
  return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
}

/** A medida do cabeçalho (arquivo ou bytes) com a orientação do arquivo aplicada; `null` se não é imagem. */
export async function sizeOf(input: string | Buffer): Promise<ImageSize | null> {
  try {
    return orientedSize(await sharp(input).metadata());
  } catch {
    return null;
  }
}
