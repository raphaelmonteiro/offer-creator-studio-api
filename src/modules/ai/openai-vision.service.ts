import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OPENAI_NO_SDK_RETRY } from '../../shared/providers/openai-errors';
import { withAiLogging } from './utils/ai-telemetry.util';

export interface VisionCompareInput {
  model: string;
  prompt: string;
  /** PNG do recorte antes da edição. */
  before: Buffer;
  /** PNG do recorte depois da edição. */
  after: Buffer;
  timeoutMs: number;
  correlationId: string;
}

export interface VisionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export interface VisionCompareResult {
  /** Conteúdo da resposta (JSON em texto). */
  text: string;
  usage: VisionUsage | null;
  requestId: string | null;
  latencyMs: number;
}

const dataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

/**
 * Pergunta ao modelo de visão (`chat.completions`) sobre duas imagens, antes e depois, com
 * `detail: low` e resposta em JSON. Uma só requisição, sem retentativa do SDK: o chamador decide o
 * que fazer com a falha (na cena, a edição vale e a resposta sai das métricas).
 */
@Injectable()
export class OpenAiVisionService {
  private readonly logger = new Logger(OpenAiVisionService.name);
  private readonly openai: OpenAI | null;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async compare(input: VisionCompareInput): Promise<VisionCompareResult> {
    if (!this.openai) throw new Error('OpenAI não configurada');
    const startedAt = Date.now();
    // O SDK instalado não tipa os modelos novos nem `reasoning_effort`: um cast só, como nas imagens.
    const body = {
      model: input.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: input.prompt },
            { type: 'image_url', image_url: { url: dataUrl(input.before), detail: 'low' } },
            { type: 'image_url', image_url: { url: dataUrl(input.after), detail: 'low' } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      ...(input.model.startsWith('gpt-6') ? { reasoning_effort: 'low' } : {}),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    const { data, response } = await withAiLogging(
      this.logger,
      {
        feature: 'template-scene',
        endpoint: 'chat.completions',
        model: input.model,
        correlationId: input.correlationId,
      },
      () =>
        this.openai!.chat.completions.create(body, {
          ...OPENAI_NO_SDK_RETRY,
          timeout: input.timeoutMs,
        }).withResponse(),
    );
    const completion = data as unknown as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: VisionUsage;
    };
    return {
      text: completion.choices[0]?.message?.content ?? '',
      usage: completion.usage ?? null,
      requestId: response.headers.get('x-request-id'),
      latencyMs: Date.now() - startedAt,
    };
  }
}
