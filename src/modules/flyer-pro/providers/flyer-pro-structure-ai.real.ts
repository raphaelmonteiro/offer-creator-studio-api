import OpenAI, { APIConnectionTimeoutError } from 'openai';
import { directorTextOf } from '../../ai/openai-director.service';
import { buildResponsesParams } from '../../ai/config/openai-chat-params';
import { llmPricesFor, type LlmUsage } from '../../ai/openai-llm-pricing';
import { classifyOpenAiError } from '../../../shared/providers/openai-errors';
import type { StructureAiConfig } from '../config/structure-ai.config';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { StructureAiRequest, StructureAiResult } from '../domain/structure-ai-request';
import { buildStructureDataMessage } from '../prompts/structure-suggestion.data-message';
import { STRUCTURE_SUGGESTION_INSTRUCTIONS } from '../prompts/structure-suggestion.prompt';
import {
  STRUCTURE_SUGGESTION_SCHEMA,
  STRUCTURE_SUGGESTION_SCHEMA_NAME,
} from '../prompts/structure-suggestion.schema';
import {
  FlyerProStructureAiPort,
  StructureAiCallOptions,
  StructureAiFailure,
} from './flyer-pro-structure-ai.port';
import { parseStructureOutput } from './structure-ai-output';

/** O que o provedor usa do SDK: `responses.create`. Os testes injetam um cliente simulado com esta forma. */
export interface StructureResponsesClient {
  responses: {
    create(
      body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
      options: object,
    ): Promise<unknown>;
  };
}

/** O que a resposta de `/responses` traz de que o provedor precisa: o texto (pelo ajudante do Diretor) e os tokens. */
type ResponsesResult = Parameters<typeof directorTextOf>[0] & { usage?: LlmUsage };

/** Prazo estourado vira `TIMEOUT`; qualquer outro erro do SDK (inclusive falta de cota e limite de taxa) vira `PROVIDER_ERROR`. */
function failureOf(error: unknown): StructureAiFailure {
  if (error instanceof APIConnectionTimeoutError) {
    return new StructureAiFailure('TIMEOUT', 'Prazo da OpenAI estourado');
  }
  // A classificação serve só ao texto do log (a linha `AI operation failed` leva a mensagem); o motivo é um só.
  const classified = classifyOpenAiError(error);
  const message = classified instanceof Error ? classified.message : 'Erro da OpenAI';
  return new StructureAiFailure('PROVIDER_ERROR', message);
}

/**
 * O provedor real: uma chamada a `/responses` com a saída presa ao schema estrito (`store: false`, sem
 * `previous_response_id`), no molde de `OpenAiDirectorService` e sem tocá-lo. Nunca chama duas vezes: falha, prazo ou saída
 * inválida sobem como `StructureAiFailure`, sem plano de reserva. Sem chave ou com modelo sem preço na tabela, a rota recusa
 * antes (`unavailableReason`) e este provedor nem é chamado.
 */
export class RealFlyerProStructureAi implements FlyerProStructureAiPort {
  readonly source = 'ai' as const;

  constructor(
    private readonly config: StructureAiConfig,
    private readonly client: StructureResponsesClient | null,
  ) {}

  unavailableReason(): 'NO_API_KEY' | 'MODEL_PRICE_UNKNOWN' | null {
    if (!this.client) return 'NO_API_KEY';
    return llmPricesFor(this.config.model) ? null : 'MODEL_PRICE_UNKNOWN';
  }

  async suggest(
    request: StructureAiRequest,
    options: StructureAiCallOptions,
  ): Promise<StructureAiResult> {
    if (!this.client) throw new StructureAiFailure('PROVIDER_ERROR', 'OpenAI não configurada');
    const { body, options: callOptions } = this.buildCall(request, options.timeoutMs);
    let response: ResponsesResult;
    try {
      response = (await this.client.responses.create(body, callOptions)) as ResponsesResult;
    } catch (error) {
      throw failureOf(error);
    }
    return {
      suggestion: parseStructureOutput(directorTextOf(response)),
      model: this.config.model,
      usage: response.usage ?? null,
    };
  }

  /** O corpo de `/responses` pelo helper da família do modelo, mais as instruções, os DADOS e o formato estrito. */
  private buildCall(request: StructureAiRequest, timeoutMs: number) {
    const params = buildResponsesParams({
      model: this.config.model,
      effort: this.config.effort,
      temperature: FLYER_PRO_LIMITS.structureTemperature,
      timeoutMs,
      maxOutputTokens: FLYER_PRO_LIMITS.structureMaxOutputTokens,
    });
    // O SDK instalado não tipa os modelos novos nem `reasoning` com todos os esforços: um cast só, como no Diretor.
    const body = {
      ...params.body,
      instructions: STRUCTURE_SUGGESTION_INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildStructureDataMessage(request) }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: STRUCTURE_SUGGESTION_SCHEMA_NAME,
          strict: true,
          schema: STRUCTURE_SUGGESTION_SCHEMA,
        },
      },
      store: false,
    } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    return { body, options: params.options };
  }
}
