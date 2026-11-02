import * as sharp from 'sharp';
import type {
  EditParams,
  GenerateParams,
  ImageResponse,
  SpikeOpenAi,
  VisionParams,
  VisionResponse,
} from './openai-client';

export type FakeBehavior = 'identical' | 'tweak';

export interface FakeOptions {
  /** `identical` devolve o recorte enviado (caso "não fez nada"); `tweak` clareia o recorte todo. */
  behavior?: FakeBehavior;
  /** Erro simulado para a chamada de número `n` (1 = primeira); null = segue normal. */
  inject?: (n: number, op: 'generate' | 'edit' | 'vision', arm?: 'mask' | 'markup') => Error | null;
  /** Remove o `usage` da resposta (cenário "resposta sem usage"). */
  omitUsage?: boolean;
}

/** Erro com a forma dos erros do SDK da OpenAI (status, code, message). */
export function providerError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Média observada na fase 1 real (2026-11-02); o brief previa 0,0039. */
const OUT_TOKENS_PER_PIXEL = 0.00046;
const IN_TOKENS_PER_PIXEL = 0.0015;

function simulatedUsage(w: number, h: number, inputs: number, promptChars: number) {
  return {
    input_tokens: Math.round(inputs * w * h * IN_TOKENS_PER_PIXEL) + Math.ceil(promptChars / 3),
    input_tokens_details: {
      image_tokens: Math.round(inputs * w * h * IN_TOKENS_PER_PIXEL),
      text_tokens: Math.ceil(promptChars / 3),
    },
    output_tokens: Math.round(w * h * OUT_TOKENS_PER_PIXEL),
  };
}

function parseSize(size: string): { w: number; h: number } {
  const [w, h] = size.split('x').map(Number);
  return { w, h };
}

export async function syntheticScene(w: number, h: number, seed: number): Promise<Buffer> {
  const hue = (seed * 67) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue},60%,70%)"/><stop offset="1" stop-color="hsl(${(hue + 90) % 360},50%,35%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.7}" cy="${h * 0.2}" r="${Math.min(w, h) * 0.08}" fill="#ffd54a"/>
    <ellipse cx="${w * 0.78}" cy="${h * 0.22}" rx="${w * 0.1}" ry="${h * 0.03}" fill="#ffffff"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Cliente falso do `--dry-run`: sem rede, imagens sintéticas e `usage` simulado. */
export class FakeOpenAi implements SpikeOpenAi {
  calls = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  private next(op: 'generate' | 'edit' | 'vision', arm?: 'mask' | 'markup'): void {
    this.calls += 1;
    const error = this.options.inject?.(this.calls, op, arm);
    if (error) throw error;
  }

  async generate(p: GenerateParams): Promise<ImageResponse> {
    this.next('generate');
    const { w, h } = parseSize(p.size);
    const png = await syntheticScene(w, h, p.prompt.length);
    return {
      png,
      usage: this.usage(simulatedUsage(w, h, 0, p.prompt.length)),
      requestId: `fake-${this.calls}`,
    };
  }

  async edit(p: EditParams): Promise<ImageResponse> {
    this.next('edit', p.markup ? 'markup' : 'mask');
    const { w, h } = parseSize(p.size);
    const inputs = 1 + (p.reference ? 1 : 0) + (p.mask || p.markup ? 1 : 0);
    const png =
      this.options.behavior === 'identical'
        ? p.image
        : await sharp(p.image).modulate({ brightness: 1.25 }).png().toBuffer();
    return {
      png,
      usage: this.usage(simulatedUsage(w, h, inputs, p.prompt.length)),
      requestId: `fake-${this.calls}`,
    };
  }

  async vision(p: VisionParams): Promise<VisionResponse> {
    this.next('vision');
    const text = JSON.stringify({ mudou: 'simulado', atendeu: 'parcial', fez_algo: true });
    const usage = this.options.omitUsage
      ? undefined
      : { prompt_tokens: 400 + p.prompt.length, completion_tokens: 40 };
    return { text, usage, requestId: `fake-${this.calls}` };
  }

  private usage<T>(usage: T): T | undefined {
    return this.options.omitUsage ? undefined : usage;
  }
}
