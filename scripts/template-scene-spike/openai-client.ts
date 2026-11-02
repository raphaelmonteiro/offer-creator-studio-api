import OpenAI from 'openai';
import * as sharp from 'sharp';
import { OPENAI_NO_SDK_RETRY, withOpenAiRetry } from '../../src/shared/providers/openai-errors';
import type { UsageRaw } from './types';

export interface GenerateParams {
  model: string;
  prompt: string;
  size: string;
  quality: string;
}

/** `mask` e `markup` nunca vão juntos (a API recusa). */
export interface EditParams {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  /** PNG do recorte enviado. */
  image: Buffer;
  /** Segunda imagem de referência (fallback do bloco B). */
  reference?: Buffer;
  mask?: Buffer;
  markup?: Buffer;
}

export interface VisionParams {
  model: string;
  prompt: string;
  before: Buffer;
  after: Buffer;
}

export interface ImageResponse {
  png: Buffer;
  usage?: UsageRaw;
  requestId: string | null;
}

export interface VisionResponse {
  text: string;
  usage?: UsageRaw;
  requestId: string | null;
}

/** Fronteira com a OpenAI: o spike só fala com este contrato (real ou falso). */
export interface SpikeOpenAi {
  generate(params: GenerateParams): Promise<ImageResponse>;
  edit(params: EditParams): Promise<ImageResponse>;
  vision(params: VisionParams): Promise<VisionResponse>;
}

const RETRY = { attempts: 3 } as const;

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Único ponto com cast: a 6.33.0 não tipa o modelo 2.5, `markup`, `quality: xhigh|max` nem tamanho
 * customizado, e o SDK serializa todas as chaves do corpo (mesmo cast do `openai-image.service.ts`).
 */
function untypedBody(body: Record<string, unknown>): any {
  return body as any;
}

interface RawImageBody {
  data?: Array<{ b64_json?: string }>;
  usage?: UsageRaw;
}

async function toImageResponse(
  raw: RawImageBody,
  requestId: string | null,
): Promise<ImageResponse> {
  const b64 = raw.data?.[0]?.b64_json;
  if (!b64) throw new Error('Resposta sem imagem (data[0].b64_json)');
  const png = await sharp(Buffer.from(b64, 'base64')).png().toBuffer();
  return { png, usage: raw.usage, requestId };
}

export class RealOpenAi implements SpikeOpenAi {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  generate(p: GenerateParams): Promise<ImageResponse> {
    return withOpenAiRetry(async () => {
      const body = untypedBody({
        model: p.model,
        prompt: p.prompt,
        size: p.size,
        quality: p.quality,
        output_format: 'png',
        background: 'opaque',
        n: 1,
      });
      const { data, response } = await this.client.images
        .generate(body, OPENAI_NO_SDK_RETRY)
        .withResponse();
      return toImageResponse(data as unknown as RawImageBody, response.headers.get('x-request-id'));
    }, RETRY);
  }

  edit(p: EditParams): Promise<ImageResponse> {
    if (p.mask && p.markup) throw new Error('mask e markup não podem ir juntos');
    return withOpenAiRetry(async () => {
      const images = [{ image_url: dataUrl(p.image) }];
      if (p.reference) images.push({ image_url: dataUrl(p.reference) });
      const body: Record<string, unknown> = {
        model: p.model,
        images,
        prompt: p.prompt,
        size: p.size,
        quality: p.quality,
        output_format: 'png',
        n: 1,
      };
      if (p.mask) body.mask = { image_url: dataUrl(p.mask) };
      if (p.markup) body.markup = { image_url: dataUrl(p.markup) };
      const { data, response } = await this.client
        .post<RawImageBody>('/images/edits', { body, ...OPENAI_NO_SDK_RETRY })
        .withResponse();
      return toImageResponse(data, response.headers.get('x-request-id'));
    }, RETRY);
  }

  vision(p: VisionParams): Promise<VisionResponse> {
    return withOpenAiRetry(async () => {
      const content = [
        { type: 'text', text: p.prompt },
        { type: 'image_url', image_url: { url: dataUrl(p.before), detail: 'low' } },
        { type: 'image_url', image_url: { url: dataUrl(p.after), detail: 'low' } },
      ];
      const body = untypedBody({
        model: p.model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
      });
      const { data, response } = await this.client.chat.completions
        .create(body, OPENAI_NO_SDK_RETRY)
        .withResponse();
      const completion = data as unknown as {
        choices: Array<{ message: { content: string | null } }>;
        usage?: UsageRaw;
      };
      const text = completion.choices[0]?.message?.content ?? '';
      return { text, usage: completion.usage, requestId: response.headers.get('x-request-id') };
    }, RETRY);
  }
}
