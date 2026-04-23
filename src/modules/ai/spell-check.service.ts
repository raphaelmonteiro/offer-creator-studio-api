import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SpellCheckProductDto } from './dto/spell-check-request.dto';
import { CorrectionDto, SpellCheckResponseDto } from './dto/spell-check-response.dto';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  AI_RESPONSE_FORMATS,
  parseSpellCheckResponse,
} from './schemas/ai-response.schemas';
import { SPELLCHECK_SYSTEM_PROMPT } from './prompts/spellcheck.prompts';
import { withAiLogging } from './utils/ai-telemetry.util';

const BATCH_SIZE = 10;

interface StructuredChatCompletionOptions<T> {
  feature: string;
  model: string;
  request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  parse: (raw: string) => T;
  emptyResponseMessage: string;
}

@Injectable()
export class SpellCheckService {
  private readonly logger = new Logger(SpellCheckService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(private readonly configService: ConfigService) {
    this.models = getOpenAiModelConfig(configService);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — chamadas à IA irão falhar');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async spellCheck(products: SpellCheckProductDto[]): Promise<SpellCheckResponseDto> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    const allItems: Array<{ productId: string; field: string; text: string }> = [];

    for (const product of products) {
      if (product.name?.trim()) {
        allItems.push({ productId: product.id, field: 'name', text: product.name });
      }
      if (product.observation?.trim()) {
        allItems.push({ productId: product.id, field: 'observation', text: product.observation });
      }
      if (product.badgeText?.trim()) {
        allItems.push({ productId: product.id, field: 'badgeText', text: product.badgeText });
      }
    }

    const batches: Array<typeof allItems> = [];
    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      batches.push(allItems.slice(i, i + BATCH_SIZE));
    }

    const batchResults = await Promise.all(batches.map((batch) => this.checkBatch(batch)));
    const corrections = batchResults.flat();

    return { corrections };
  }

  private async checkBatch(
    items: Array<{ productId: string; field: string; text: string }>,
  ): Promise<CorrectionDto[]> {
    const userPrompt =
      'Analise os seguintes itens e retorne apenas os que possuem erros ortográficos:\n\n' +
      JSON.stringify(items, null, 2);

    return this.createStructuredChatCompletion({
      feature: 'spell-check.batch',
      model: this.models.textModel,
      emptyResponseMessage: 'Resposta vazia da IA',
      parse: parseSpellCheckResponse,
      request: {
        model: this.models.textModel,
        response_format: AI_RESPONSE_FORMATS.spellCheck,
        max_tokens: 2048,
        temperature: 0,
        messages: [
          { role: 'system', content: SPELLCHECK_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
    });
  }

  private async createStructuredChatCompletion<T>(
    options: StructuredChatCompletionOptions<T>,
  ): Promise<T> {
    const maxAttempts = this.models.structuredResponseRetryAttempts + 1;
    const messages = [...options.request.messages];
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await withAiLogging(
        this.logger,
        {
          feature: options.feature,
          endpoint: 'chat.completions',
          model: options.model,
        },
        () =>
          this.openai!.chat.completions.create({
            ...options.request,
            messages,
          }),
      );

      const raw = response.choices[0]?.message?.content;
      try {
        if (!raw) throw new Error(options.emptyResponseMessage);
        return options.parse(raw);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) {
          throw error;
        }

        const reason = this.getStructuredResponseRetryReason(error);
        this.logger.warn(
          `Structured response retry ${JSON.stringify({
            feature: options.feature,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            reason,
            model: options.model,
          })}`,
        );

        messages.push({
          role: 'user',
          content:
            'The previous response was invalid for the expected JSON schema. ' +
            `Validation error: ${reason}. ` +
            'Return only valid JSON for the expected schema, without markdown or explanations.',
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Resposta estruturada inválida da IA');
  }

  private getStructuredResponseRetryReason(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message.slice(0, 180);
    }

    return 'structured-response-validation-failed';
  }
}
