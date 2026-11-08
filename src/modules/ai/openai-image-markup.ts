import * as sharp from 'sharp';
import { MARKUP_MAX_PIXELS } from '../../shared/image/openai-image-capabilities';
import { SCENE_INVALID_REQUEST_CODE } from '../../shared/providers/openai-scene-call-errors';
import { TerminalProviderError } from '../../shared/providers/provider-errors';

/** Camada de marcação da edição: PNG com fundo transparente, do tamanho da imagem enviada. */
export interface MarkupInput {
  buffer: Buffer;
}

const invalid = (message: string) => new TerminalProviderError(message, SCENE_INVALID_REQUEST_CODE);

async function dimensionsOf(buffer: Buffer, what: string): Promise<{ w: number; h: number }> {
  try {
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) throw new Error('sem dimensões');
    return { w: width, h: height };
  } catch {
    throw invalid(`${what} ilegível na edição com markup`);
  }
}

/**
 * Confere antes da rede o que a API exige do `markup`: mesma largura e altura da imagem e até
 * 16.777.216 pixels em cada uma (guia de imagens, 2026-11-06). `size` é o pedido ao modelo.
 */
export async function assertMarkupMatchesImage(input: {
  image: Buffer | undefined;
  markup: MarkupInput;
  size: string;
}): Promise<void> {
  if (!input.image) throw invalid('Nenhuma imagem informada para edição');
  const image = await dimensionsOf(input.image, 'Imagem');
  const markup = await dimensionsOf(input.markup.buffer, 'Markup');
  if (markup.w !== image.w || markup.h !== image.h) {
    throw invalid(
      `O markup (${markup.w}x${markup.h}) precisa ter o tamanho da imagem (${image.w}x${image.h})`,
    );
  }
  if (image.w * image.h > MARKUP_MAX_PIXELS) {
    throw invalid(`A imagem tem mais de ${MARKUP_MAX_PIXELS} pixels, o limite do markup`);
  }
  if (input.size !== `${image.w}x${image.h}`) {
    throw invalid(`O tamanho pedido (${input.size}) difere da imagem (${image.w}x${image.h})`);
  }
}
