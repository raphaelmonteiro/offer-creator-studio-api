import * as sharp from 'sharp';
import { SceneElement } from '../domain/scene.types';

const DARK_TEXT = '#1f1f1f';
const LIGHT_TEXT = '#ffffff';

/** Luminância relativa (0 a 255) com os pesos de Rec. 709. */
const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Cor da camada de texto por contraste (D-51, defeito c): a luminância média da master sob a caixa da camada decide
 * entre `#1f1f1f` (fundo claro) e `#ffffff` (fundo escuro). Sem leitura possível, o branco de sempre.
 */
export async function textColorUnder(
  master: Buffer,
  element: SceneElement,
  size: { widthPx: number; heightPx: number },
): Promise<string> {
  try {
    const w = element.w * size.widthPx;
    const h = w / element.aspect;
    const left = Math.max(0, Math.round(element.x * size.widthPx - w / 2));
    const top = Math.max(0, Math.round(element.y * size.heightPx - h / 2));
    const width = Math.max(1, Math.min(size.widthPx - left, Math.round(w)));
    const height = Math.max(1, Math.min(size.heightPx - top, Math.round(h)));
    const { data } = await sharp(master)
      .extract({ left, top, width, height })
      .resize(1, 1, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return luminance(data[0], data[1], data[2]) > 140 ? DARK_TEXT : LIGHT_TEXT;
  } catch {
    return LIGHT_TEXT;
  }
}

/** Dá a cor por contraste às camadas de texto que nasceram agora; as que já existiam ficam como estão. */
export async function colorNewTexts(
  before: SceneElement[],
  after: SceneElement[],
  input: { master: Buffer; widthPx: number; heightPx: number },
): Promise<SceneElement[]> {
  const known = new Set(before.map((element) => element.id));
  return Promise.all(
    after.map(async (element) =>
      element.kind === 'text' && !known.has(element.id)
        ? { ...element, color: await textColorUnder(input.master, element, input) }
        : element,
    ),
  );
}
