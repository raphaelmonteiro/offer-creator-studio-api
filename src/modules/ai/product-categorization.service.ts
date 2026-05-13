import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ProductCategorizationProductDto,
  ProductCategorizationRequestDto,
} from './dto/product-categorization-request.dto';
import {
  ProductCategoryAssignmentDto,
  ProductCategorizationResponseDto,
} from './dto/product-categorization-response.dto';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  AI_RESPONSE_FORMATS,
  parseProductCategorizationResponse,
} from './schemas/ai-response.schemas';
import { PRODUCT_CATEGORIZATION_SYSTEM_PROMPT } from './prompts/product-categorization.prompts';
import { withAiLogging } from './utils/ai-telemetry.util';

export const DEFAULT_PRODUCT_CATEGORIES = [
  'Hortifruti',
  'Bebidas',
  'Carnes',
  'Padaria',
  'Limpeza',
  'Mercearia',
  'Frios e Laticinios',
  'Higiene e Perfumaria',
  'Congelados',
  'Pet',
  'Bazar',
  'Sem categoria',
] as const;

const FALLBACK_CATEGORY = 'Sem categoria';
const DEFAULT_BATCH_SIZE = 40;
const DEFAULT_MAX_PRODUCTS = 500;
const UNCERTAIN_CONFIDENCE_THRESHOLD = 0.65;

interface ProductCategoryCandidate {
  product: ProductCategorizationProductDto;
  duplicateProductIds: string[];
}

interface StructuredChatCompletionOptions<T> {
  feature: string;
  model: string;
  request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  parse: (raw: string) => T;
  emptyResponseMessage: string;
}

@Injectable()
export class ProductCategorizationService {
  private readonly logger = new Logger(ProductCategorizationService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(private readonly configService: ConfigService) {
    this.models = getOpenAiModelConfig(configService);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — categorização usará fallback');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async categorizeProducts(
    dto: ProductCategorizationRequestDto,
  ): Promise<ProductCategorizationResponseDto> {
    const allowedCategories = this.normalizeAllowedCategories(dto.allowedCategories);
    const preserveExistingCategories = dto.preserveExistingCategories !== false;
    const maxProducts = this.getPositiveIntegerConfig(
      'AI_PRODUCT_CATEGORIZATION_MAX_PRODUCTS',
      DEFAULT_MAX_PRODUCTS,
    );
    const products = dto.products.slice(0, maxProducts);
    const assignmentsByProductId = new Map<string, ProductCategoryAssignmentDto>();
    const remainingProducts: ProductCategorizationProductDto[] = [];

    for (const product of products) {
      const existingCategory = preserveExistingCategories
        ? this.findAllowedCategory(product.currentCategory, allowedCategories)
        : undefined;

      if (existingCategory) {
        assignmentsByProductId.set(product.id, {
          productId: product.id,
          category: existingCategory,
          confidence: 1,
          source: 'existing',
          reason: 'Categoria existente preservada.',
        });
      } else {
        remainingProducts.push(product);
      }
    }

    if (remainingProducts.length === 0) {
      return this.buildResponse(products, assignmentsByProductId);
    }

    if (!this.isEnabled() || !this.openai) {
      this.addFallbackAssignments(remainingProducts, assignmentsByProductId, allowedCategories);
      return this.buildResponse(products, assignmentsByProductId);
    }

    const candidates = this.dedupeProducts(remainingProducts);
    const batchSize = this.getPositiveIntegerConfig(
      'AI_PRODUCT_CATEGORIZATION_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
    );

    for (const batch of this.chunk(candidates, batchSize)) {
      const result = await this.categorizeBatch(batch, allowedCategories);
      const resultByProductId = new Map(
        result.assignments.map((assignment) => [assignment.productId, assignment]),
      );

      for (const candidate of batch) {
        const assignment = resultByProductId.get(candidate.product.id);
        const sanitizedAssignment = assignment
          ? this.sanitizeAiAssignment(assignment, candidate.product.id, allowedCategories)
          : this.createFallbackAssignment(candidate.product.id, allowedCategories);

        for (const productId of [candidate.product.id, ...candidate.duplicateProductIds]) {
          assignmentsByProductId.set(productId, {
            ...sanitizedAssignment,
            productId,
          });
        }
      }
    }

    return this.buildResponse(products, assignmentsByProductId);
  }

  private async categorizeBatch(
    candidates: ProductCategoryCandidate[],
    allowedCategories: string[],
  ): Promise<{ assignments: ProductCategoryAssignmentDto[] }> {
    const userPrompt = JSON.stringify(
      {
        allowedCategories,
        products: candidates.map(({ product }) => ({
          id: product.id,
          name: product.name,
          description: product.description || null,
          currentCategory: product.currentCategory || null,
          unit: product.unit || null,
        })),
      },
      null,
      2,
    );

    return this.createStructuredChatCompletion({
      feature: 'product-categorization.batch',
      model: this.models.fastTextModel,
      emptyResponseMessage: 'Resposta vazia da IA',
      parse: parseProductCategorizationResponse,
      request: {
        model: this.models.fastTextModel,
        response_format: AI_RESPONSE_FORMATS.productCategorization,
        max_tokens: Math.min(4096, 300 + candidates.length * 90),
        temperature: 0,
        messages: [
          { role: 'system', content: PRODUCT_CATEGORIZATION_SYSTEM_PROMPT },
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

  private normalizeAllowedCategories(categories?: string[]): string[] {
    const source = categories?.length ? categories : [...DEFAULT_PRODUCT_CATEGORIES];
    const normalized = source.reduce<string[]>((acc, category) => {
      const value = category.trim();
      if (!value) return acc;

      const exists = acc.some(
        (candidate) => this.normalizeComparableText(candidate) === this.normalizeComparableText(value),
      );
      if (!exists) {
        acc.push(value);
      }
      return acc;
    }, []);

    if (!this.findAllowedCategory(FALLBACK_CATEGORY, normalized)) {
      normalized.push(FALLBACK_CATEGORY);
    }

    return normalized;
  }

  private dedupeProducts(products: ProductCategorizationProductDto[]): ProductCategoryCandidate[] {
    const candidates = new Map<string, ProductCategoryCandidate>();

    for (const product of products) {
      const key = [
        this.normalizeComparableText(product.name),
        this.normalizeComparableText(product.description || ''),
        this.normalizeComparableText(product.unit || ''),
      ].join('|');
      const existing = candidates.get(key);

      if (existing) {
        existing.duplicateProductIds.push(product.id);
      } else {
        candidates.set(key, { product, duplicateProductIds: [] });
      }
    }

    return [...candidates.values()];
  }

  private sanitizeAiAssignment(
    assignment: ProductCategoryAssignmentDto,
    productId: string,
    allowedCategories: string[],
  ): ProductCategoryAssignmentDto {
    const category = this.findAllowedCategory(assignment.category, allowedCategories);
    if (!category) {
      return this.createFallbackAssignment(productId, allowedCategories);
    }

    return {
      productId,
      category,
      confidence: Math.max(0, Math.min(1, assignment.confidence)),
      source: 'ai',
      reason: assignment.reason,
    };
  }

  private addFallbackAssignments(
    products: ProductCategorizationProductDto[],
    assignmentsByProductId: Map<string, ProductCategoryAssignmentDto>,
    allowedCategories: string[],
  ) {
    for (const product of products) {
      assignmentsByProductId.set(
        product.id,
        this.createFallbackAssignment(product.id, allowedCategories),
      );
    }
  }

  private createFallbackAssignment(
    productId: string,
    allowedCategories: string[],
  ): ProductCategoryAssignmentDto {
    return {
      productId,
      category: this.findAllowedCategory(FALLBACK_CATEGORY, allowedCategories) || allowedCategories[0],
      confidence: 0,
      source: 'fallback',
      reason: 'Categoria não identificada com segurança.',
    };
  }

  private buildResponse(
    products: ProductCategorizationProductDto[],
    assignmentsByProductId: Map<string, ProductCategoryAssignmentDto>,
  ): ProductCategorizationResponseDto {
    const assignments = products.map((product) => {
      const assignment = assignmentsByProductId.get(product.id);
      if (assignment) return assignment;

      return {
        productId: product.id,
        category: FALLBACK_CATEGORY,
        confidence: 0,
        source: 'fallback' as const,
        reason: 'Categoria não identificada com segurança.',
      };
    });

    return {
      assignments,
      summary: {
        total: assignments.length,
        categorized: assignments.filter((assignment) => assignment.category !== FALLBACK_CATEGORY)
          .length,
        uncertain: assignments.filter(
          (assignment) =>
            assignment.confidence < UNCERTAIN_CONFIDENCE_THRESHOLD ||
            assignment.category === FALLBACK_CATEGORY,
        ).length,
      },
    };
  }

  private findAllowedCategory(value: string | null | undefined, allowedCategories: string[]) {
    if (!value?.trim()) return undefined;

    const comparable = this.normalizeComparableText(value);
    return allowedCategories.find(
      (category) => this.normalizeComparableText(category) === comparable,
    );
  }

  private normalizeComparableText(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private getPositiveIntegerConfig(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key, String(defaultValue));
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  }

  private isEnabled(): boolean {
    return this.configService.get<string>('AI_PRODUCT_CATEGORIZATION_ENABLED', 'true') !== 'false';
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private getStructuredResponseRetryReason(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message.slice(0, 180);
    }

    return 'structured-response-validation-failed';
  }
}
