import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { OPENAI_NO_SDK_RETRY } from '../../shared/providers/openai-errors';
import { LlmUsage } from './openai-llm-pricing';
import { withAiLogging } from './utils/ai-telemetry.util';

export interface DirectorCompletionInput {
  model: string;
  /** Instruções fixas (regras, classes, campos). */
  instructions: string;
  /** A mensagem do turno: histórico, lista de pedidos, versões, marcação, camadas e a mensagem atual, como dado. */
  text: string;
  /** JPEG da imagem atual (até 1.536 px); `null` na cena sem imagem. */
  image: Buffer | null;
  /** Schema fechado da saída (`text.format: json_schema`, `strict`). */
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
  correlationId: string;
}

export interface DirectorCompletionResult {
  /** Conteúdo da resposta (JSON em texto); vazio se a resposta veio incompleta. */
  text: string;
  usage: LlmUsage | null;
  requestId: string | null;
  latencyMs: number;
}

/** Teto de tokens de saída (o raciocínio `medium` conta aqui). Medido na Etapa 0: máximo de 837. */
export const DIRECTOR_MAX_OUTPUT_TOKENS = 6000;
export const DIRECTOR_REASONING_EFFORT = 'medium';

const dataUrl = (jpeg: Buffer): string => `data:image/jpeg;base64,${jpeg.toString('base64')}`;

/** Corpo do `POST /responses`: sem `previous_response_id` (D-23) e com `store: false`. */
export function buildDirectorRequest(input: DirectorCompletionInput): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: input.text }];
  if (input.image) {
    content.push({ type: 'input_image', image_url: dataUrl(input.image), detail: 'high' });
  }
  return {
    model: input.model,
    instructions: input.instructions,
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: input.jsonSchema.name,
        strict: true,
        schema: input.jsonSchema.schema,
      },
    },
    reasoning: { effort: DIRECTOR_REASONING_EFFORT },
    max_output_tokens: DIRECTOR_MAX_OUTPUT_TOKENS,
    store: false,
  };
}

interface ResponsesOutput {
  status?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: LlmUsage;
}

/** Junta o texto das mensagens da resposta; resposta incompleta ou recusada não devolve texto. */
export function directorTextOf(response: ResponsesOutput): string {
  if (response.status && response.status !== 'completed') return '';
  return (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Pergunta ao Diretor (`gpt-6-luna`, `/responses`) e devolve o JSON do plano. Uma só requisição, sem
 * retentativa do SDK: o chamador decide o que fazer com a falha. A conversa vem inteira do nosso banco a
 * cada turno, então não há `previous_response_id` e nada fica guardado no provedor (`store: false`).
 */
@Injectable()
export class OpenAiDirectorService {
  private readonly logger = new Logger(OpenAiDirectorService.name);
  private readonly openai: OpenAI | null;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async plan(input: DirectorCompletionInput): Promise<DirectorCompletionResult> {
    if (!this.openai) throw new Error('OpenAI não configurada');
    const startedAt = Date.now();
    // O SDK instalado não tipa os modelos novos nem `reasoning` com `effort: medium`: um cast só, como na visão.
    const body = buildDirectorRequest(
      input,
    ) as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const { data, response } = await withAiLogging(
      this.logger,
      {
        feature: 'template-scene-director',
        endpoint: 'responses',
        model: input.model,
        correlationId: input.correlationId,
      },
      () =>
        this.openai!.responses.create(body, {
          ...OPENAI_NO_SDK_RETRY,
          timeout: input.timeoutMs,
        }).withResponse(),
    );
    const parsed = data as unknown as ResponsesOutput;
    return {
      text: directorTextOf(parsed),
      usage: parsed.usage ?? null,
      requestId: response.headers.get('x-request-id'),
      latencyMs: Date.now() - startedAt,
    };
  }
}
