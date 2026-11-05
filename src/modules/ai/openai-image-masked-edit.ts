import * as sharp from 'sharp';
import { SCENE_INVALID_REQUEST_CODE } from '../../shared/providers/openai-scene-call-errors';
import { TerminalProviderError } from '../../shared/providers/provider-errors';

/** Máscara PNG da edição local: alfa 255 = editar, mesmo tamanho do recorte. */
export interface MaskedEditInput {
  buffer: Buffer;
}

export interface MaskedEditBodyInput {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  image: { buffer?: Buffer; mimeType: string };
  mask: MaskedEditInput;
}

const invalid = (message: string) => new TerminalProviderError(message, SCENE_INVALID_REQUEST_CODE);

const dataUrl = (buffer: Buffer, mimeType: string): string =>
  `data:${mimeType};base64,${buffer.toString('base64')}`;

async function dimensionsOf(buffer: Buffer, what: string): Promise<string> {
  try {
    const { width, height } = await sharp(buffer).metadata();
    if (!width || !height) throw new Error('sem dimensões');
    return `${width}x${height}`;
  } catch {
    throw invalid(`${what} ilegível na edição com máscara`);
  }
}

/**
 * Corpo JSON de `POST /images/edits` com máscara (mecanismo M3): `images` no plural, `mask` com
 * `image_url` em data URL, sem `markup` (a API recusa os dois juntos) e sem `output_compression`.
 * Recusa antes de ir à rede quando a máscara não tem o tamanho do recorte ou do `size` pedido.
 */
export async function buildMaskedEditBody(
  input: MaskedEditBodyInput,
): Promise<Record<string, unknown>> {
  if (!input.image.buffer) throw invalid('Nenhuma imagem informada para edição');
  const imageSize = await dimensionsOf(input.image.buffer, 'Recorte');
  const maskSize = await dimensionsOf(input.mask.buffer, 'Máscara');
  if (maskSize !== imageSize) {
    throw invalid(`A máscara (${maskSize}) precisa ter o tamanho do recorte (${imageSize})`);
  }
  if (input.size !== imageSize) {
    throw invalid(`O tamanho pedido (${input.size}) difere do recorte (${imageSize})`);
  }
  return {
    model: input.model,
    images: [{ image_url: dataUrl(input.image.buffer, input.image.mimeType) }],
    mask: { image_url: dataUrl(input.mask.buffer, 'image/png') },
    prompt: input.prompt,
    size: input.size,
    quality: input.quality,
    output_format: input.outputFormat,
    background: input.background,
    n: 1,
  };
}
