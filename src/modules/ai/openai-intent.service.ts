import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OPENAI_NO_SDK_RETRY } from '../../shared/providers/openai-errors';
import { VisionUsage } from './openai-vision.service';
import { withAiLogging } from './utils/ai-telemetry.util';

export interface IntentCompletionInput {
  model: string;
  /** Instruções fixas (regras, contexto). */
  system: string;
  /** Texto do cliente, tratado como dado. */
  user: string;
  /** Schema fechado da saída (`response_format: json_schema`, `strict`). */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
  correlationId: string;
}

export interface IntentCompletionResult {
  /** Conteúdo da resposta (JSON em texto). */
  text: string;
  usage: VisionUsage | null;
  requestId: string | null;
  latencyMs: number;
}

/** Teto de tokens de saída (o raciocínio `low` conta aqui): protege o custo de uma mensagem. */
const MAX_COMPLETION_TOKENS = 1000;

/**
 * Pergunta ao modelo de texto (`chat.completions`) e devolve o JSON pedido. Só texto, nunca imagem.
 * Uma só requisição, sem retentativa do SDK: o chamador decide o que fazer com a falha (na cena, o
 * pedido cai em pedir a área ou confirmar a edição).
 */
@Injectable()
export class OpenAiIntentService {
  private readonly logger = new Logger(OpenAiIntentService.name);
  private readonly openai: OpenAI | null;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async classify(input: IntentCompletionInput): Promise<IntentCompletionResult> {
    if (!this.openai) throw new Error('OpenAI não configurada');
    const startedAt = Date.now();
    // O SDK instalado não tipa os modelos novos nem `reasoning_effort`: um cast só, como na visão.
    const body = {
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema },
      },
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      ...(input.model.startsWith('gpt-6') ? { reasoning_effort: 'low' } : {}),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    const { data, response } = await withAiLogging(
      this.logger,
      {
        feature: 'template-scene-intent',
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
