import { boxBlur3, cropImg, Img, imgToPng, loadRgb, lumaOf, pasteImg, resizeImg } from './rgb';

const img = (width: number, height: number, fn: (x: number, y: number) => number[]): Img => {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(fn(x, y), (y * width + x) * 3);
  }
  return { width, height, data };
};

describe('rgb', () => {
  it('PNG de ida e volta não altera nenhum byte', async () => {
    const original = img(16, 16, (x, y) => [x * 10, y * 10, (x + y) * 5]);
    const back = await loadRgb(await imgToPng(original));
    expect(Array.from(back.data)).toEqual(Array.from(original.data));
  });

  it('recorta e cola sem mexer fora do retângulo', () => {
    const base = img(8, 8, () => [1, 2, 3]);
    const patch = img(2, 2, () => [9, 9, 9]);
    const pasted = pasteImg(base, patch, 3, 3);
    expect(Array.from(cropImg(pasted, 3, 3, 2, 2).data)).toEqual(Array(12).fill(9));
    expect(Array.from(pasted.data.slice(0, 3))).toEqual([1, 2, 3]);
    expect(base.data[(3 * 8 + 3) * 3]).toBe(1);
  });

  it('redimensiona e devolve a mesma imagem quando o tamanho já é o pedido', async () => {
    const a = img(10, 10, () => [100, 100, 100]);
    expect(await resizeImg(a, 10, 10)).toBe(a);
    const b = await resizeImg(a, 5, 4);
    expect([b.width, b.height]).toEqual([5, 4]);
    expect(Array.from(b.data.slice(0, 3))).toEqual([100, 100, 100]);
  });

  it('borrão 3x3 mantém cor sólida e suaviza um ponto', () => {
    expect(new Set(boxBlur3(img(5, 5, () => [50, 50, 50])).data)).toEqual(new Set([50]));
    const dot = img(5, 5, (x, y) => (x === 2 && y === 2 ? [90, 90, 90] : [0, 0, 0]));
    const blurred = boxBlur3(dot);
    expect(blurred.data[(2 * 5 + 2) * 3]).toBe(10);
    expect(blurred.data[(2 * 5 + 1) * 3]).toBe(10);
    expect(blurred.data[0]).toBe(0);
  });

  it('luma Rec. 601 arredondada', () => {
    expect(Array.from(lumaOf(img(2, 1, (x) => (x === 0 ? [255, 255, 255] : [255, 0, 0]))))).toEqual(
      [255, 76],
    );
  });
});
