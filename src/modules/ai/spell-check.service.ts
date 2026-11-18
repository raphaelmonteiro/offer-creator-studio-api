import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SpellCheckProductDto } from './dto/spell-check-request.dto';
import { CorrectionDto, SpellCheckResponseDto } from './dto/spell-check-response.dto';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  getProductAiConfig,
  ProductAiFeatureConfig,
  readPositiveIntegerConfig,
} from './config/openai-product-features.config';
import { SPELLCHECK_CEILING } from './config/openai-product-ceilings';
import { AI_RESPONSE_FORMATS, parseSpellCheckResponse } from './schemas/ai-response.schemas';
import { SPELLCHECK_SYSTEM_PROMPT } from './prompts/spellcheck.prompts';
import { createStructuredChatCompletion } from './utils/ai-structured-chat.util';
import { AiUsageCollector, AiUsageOptions } from './utils/ai-usage';
import { runWithConcurrency } from './utils/run-with-concurrency.util';

const BATCH_SIZE = 10;
const DEFAULT_CONCURRENCY = 4;

type SpellCheckItem = { productId: string; field: string; text: string };

@Injectable()
export class SpellCheckService {
  private readonly logger = new Logger(SpellCheckService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;
  private readonly feature: ProductAiFeatureConfig;
  private readonly enabled: boolean;
  private readonly concurrency: number;

  constructor(private readonly configService: ConfigService) {
    this.models = getOpenAiModelConfig(configService);
    this.feature = getProductAiConfig(configService).spellcheck;
    this.enabled = configService.get<string>('AI_SPELLCHECK_ENABLED', 'true') !== 'false';
    this.concurrency = readPositiveIntegerConfig(
      configService,
      'AI_SPELLCHECK_CONCURRENCY',
      DEFAULT_CONCURRENCY,
    );

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — chamadas à IA irão falhar');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  /** Chave da OpenAI presente e `AI_SPELLCHECK_ENABLED` diferente de `false`; não chama o provedor. */
  isAvailable(): boolean {
    return this.openai !== null && this.enabled;
  }

  async spellCheck(
    products: SpellCheckProductDto[],
    options: AiUsageOptions = {},
  ): Promise<SpellCheckResponseDto> {
    options.usage?.declareModel(this.feature.model);
    if (!this.enabled) {
      throw new Error('AI_SPELLCHECK_ENABLED=false: revisão ortográfica desligada');
    }
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    const allItems: SpellCheckItem[] = [];

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

    const batchResults = await runWithConcurrency(batches, this.concurrency, (batch) =>
      this.checkBatch(batch, options.usage),
    );
    const corrections = batchResults.flat();

    return { corrections };
  }

  private async checkBatch(
    items: SpellCheckItem[],
    usage?: AiUsageCollector,
  ): Promise<CorrectionDto[]> {
    const userPrompt =
      'Analise os seguintes itens e retorne apenas os que possuem erros ortográficos:\n\n' +
      JSON.stringify(items, null, 2);

    return createStructuredChatCompletion({
      openai: this.openai!,
      logger: this.logger,
      usage,
      feature: 'spell-check.batch',
      spec: {
        model: this.feature.model,
        effort: 'low',
        temperature: 0,
        timeoutMs: this.feature.timeoutMs,
        ...SPELLCHECK_CEILING,
      },
      messages: [
        { role: 'system', content: SPELLCHECK_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      responseFormat: AI_RESPONSE_FORMATS.spellCheck,
      parse: parseSpellCheckResponse,
      emptyResponseMessage: 'Resposta vazia da IA',
      retryAttempts: this.models.structuredResponseRetryAttempts,
    });
  }
}
