import * as sharp from 'sharp';

/** Imagem RGB de 8 bits (sRGB, sem alfa), 3 canais intercalados. */
export interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

export async function loadRgb(png: Buffer): Promise<Img> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function imgToPng(img: Img): Promise<Buffer> {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .png()
    .toBuffer();
}

/** Redimensiona com Lanczos; devolve a mesma imagem quando o tamanho já é o pedido. */
export async function resizeImg(img: Img, width: number, height: number): Promise<Img> {
  if (img.width === width && img.height === height) return img;
  const { data } = await sharp(
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    { raw: { width: img.width, height: img.height, channels: 3 } },
  )
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width, height, data: new Uint8Array(data) };
}

export function cropImg(img: Img, x: number, y: number, w: number, h: number): Img {
  const out = new Uint8Array(w * h * 3);
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * img.width + x) * 3;
    out.set(img.data.subarray(from, from + w * 3), row * w * 3);
  }
  return { width: w, height: h, data: out };
}

/** Cola `patch` em `base` na posição (x, y), devolvendo uma cópia. */
export function pasteImg(base: Img, patch: Img, x: number, y: number): Img {
  const data = base.data.slice();
  for (let row = 0; row < patch.height; row += 1) {
    const to = ((y + row) * base.width + x) * 3;
    data.set(patch.data.subarray(row * patch.width * 3, (row + 1) * patch.width * 3), to);
  }
  return { width: base.width, height: base.height, data };
}

/**
 * Borrão de caixa 3x3 por canal, com borda replicada. Os laços quentes evitam `Math.*`: sob o Jest
 * essas chamadas ficam dezenas de vezes mais lentas, e o resultado é o mesmo (a soma inteira dividida
 * por 9 nunca cai em .5, então `round(s/9) = floor((2s+9)/18)`).
 */
export function boxBlur3(img: Img): Img {
  const { width, height } = img;
  const tmp = new Uint16Array(img.data.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const l = x > 0 ? x - 1 : 0;
      const r = x < width - 1 ? x + 1 : width - 1;
      for (let c = 0; c < 3; c += 1) {
        tmp[(row + x) * 3 + c] =
          img.data[(row + l) * 3 + c] + img.data[(row + x) * 3 + c] + img.data[(row + r) * 3 + c];
      }
    }
  }
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < height; y += 1) {
    const up = (y > 0 ? y - 1 : 0) * width;
    const mid = y * width;
    const down = (y < height - 1 ? y + 1 : height - 1) * width;
    for (let x = 0; x < width * 3; x += 1) {
      const sum = tmp[up * 3 + x] + tmp[mid * 3 + x] + tmp[down * 3 + x];
      out[mid * 3 + x] = (2 * sum + 9) / 18;
    }
  }
  return { width, height, data: out };
}

/** Luma (Rec. 601) de 8 bits. */
export function lumaOf(img: Img): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i += 1) {
    out[i] =
      0.299 * img.data[i * 3] + 0.587 * img.data[i * 3 + 1] + 0.114 * img.data[i * 3 + 2] + 0.5;
  }
  return out;
}
