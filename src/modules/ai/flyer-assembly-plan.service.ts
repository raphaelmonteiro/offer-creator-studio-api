import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  FlyerAssemblyLayoutDensity,
  FlyerAssemblyPlanRequestDto,
  FlyerAssemblyProductDto,
} from './dto/flyer-assembly-plan-request.dto';
import {
  FlyerAssemblyPagePlanDto,
  FlyerAssemblyPlanResponseDto,
  FlyerAssemblyPlanSource,
  FlyerAssemblySectionLayout,
  FlyerAssemblySectionPlanDto,
} from './dto/flyer-assembly-plan-response.dto';
import {
  AI_RESPONSE_FORMATS,
  FlyerAssemblyPlanSchemaResult,
  parseFlyerAssemblyPlanResponse,
} from './schemas/ai-response.schemas';
import { FLYER_ASSEMBLY_SYSTEM_PROMPT } from './prompts/flyer-assembly.prompts';
import { withAiLogging } from './utils/ai-telemetry.util';

const DEFAULT_MAX_PRODUCTS = 300;
const DEFAULT_MAX_PRODUCTS_PER_PAGE = 36;
const DEFAULT_CATEGORY = 'Sem categoria';
const ALLOWED_LAYOUTS: FlyerAssemblySectionLayout[] = [
  'balanced-grid',
  'dense-grid',
  'hero-grid',
];
const COMMERCIAL_CATEGORY_ORDER = [
  'Hortifruti',
  'Carnes',
  'Frios e Laticinios',
  'Padaria',
  'Bebidas',
  'Mercearia',
  'Congelados',
  'Limpeza',
  'Higiene e Perfumaria',
  'Pet',
  'Bazar',
  DEFAULT_CATEGORY,
];

interface StructuredChatCompletionOptions<T> {
  feature: string;
  model: string;
  request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  parse: (raw: string) => T;
  emptyResponseMessage: string;
}

@Injectable()
export class FlyerAssemblyPlanService {
  private readonly logger = new Logger(FlyerAssemblyPlanService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(private readonly configService: ConfigService) {
    this.models = getOpenAiModelConfig(configService);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — montagem usará fallback');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async createPlan(dto: FlyerAssemblyPlanRequestDto): Promise<FlyerAssemblyPlanResponseDto> {
    const maxProducts = this.getPositiveIntegerConfig(
      'AI_FLYER_ASSEMBLY_MAX_PRODUCTS',
      DEFAULT_MAX_PRODUCTS,
    );
    const products = this.normalizeProducts(dto.products).slice(0, maxProducts);

    if (products.length === 0) {
      return this.buildResponse([], [], [], ['Nenhum produto recebido para montagem.'], 'fallback');
    }

    if (!this.isEnabled() || !this.openai) {
      return this.createFallbackPlan(dto, products, [
        'Montagem gerada por fallback deterministico.',
      ]);
    }

    try {
      const rawPlan = await this.createAiPlan(dto, products);
      const sanitizedPlan = this.sanitizePlan(rawPlan, products, dto);
      const placedProductIds = new Set(
        sanitizedPlan.pages.flatMap((page) =>
          page.sections.flatMap((section) => section.productIds),
        ),
      );
      const missingRatio = 1 - placedProductIds.size / Math.max(1, products.length);

      if (missingRatio > 0.08 && dto.options?.allowMultiplePages !== false) {
        return this.createFallbackPlan(dto, products, [
          `Plano da IA descartado: ${(missingRatio * 100).toFixed(0)}% dos produtos ficaram fora ou invalidos.`,
          'Montagem gerada por fallback deterministico.',
        ]);
      }

      return this.buildResponse(
        sanitizedPlan.pages,
        sanitizedPlan.unplacedProductIds,
        products,
        sanitizedPlan.notes,
        'ai',
      );
    } catch (error) {
      this.logger.warn(
        `Falha ao gerar plano de montagem com IA; usando fallback. ${String(error)}`,
      );
      return this.createFallbackPlan(dto, products, [
        'IA indisponivel ou retornou plano invalido. Montagem gerada por fallback.',
      ]);
    }
  }

  private async createAiPlan(
    dto: FlyerAssemblyPlanRequestDto,
    products: FlyerAssemblyProductDto[],
  ): Promise<FlyerAssemblyPlanSchemaResult> {
    const payload = {
      template: dto.template,
      document: {
        name: dto.document.name,
        format: dto.document.format || null,
      },
      options: this.normalizeOptions(dto),
      products: products.map((product) => ({
        id: product.id,
        name: product.name,
        price: product.price,
        originalPrice: product.originalPrice ?? null,
        unit: product.unit,
        category: this.normalizeCategory(product.category),
        hasImage: product.hasImage,
        imageQuality: product.imageQuality || null,
        observation: product.observation || null,
      })),
    };

    const userPrompt = JSON.stringify(payload, null, 2);
    const maxTokens = Math.min(12000, 900 + products.length * 65);

    return this.createStructuredChatCompletion({
      feature: 'flyer-assembly.plan',
      model: this.models.fastTextModel,
      emptyResponseMessage: 'Resposta vazia da IA',
      parse: parseFlyerAssemblyPlanResponse,
      request: {
        model: this.models.fastTextModel,
        response_format: AI_RESPONSE_FORMATS.flyerAssemblyPlan,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: 'system', content: FLYER_ASSEMBLY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
    });
  }

  private createFallbackPlan(
    dto: FlyerAssemblyPlanRequestDto,
    products: FlyerAssemblyProductDto[],
    notes: string[],
  ): FlyerAssemblyPlanResponseDto {
    const options = this.normalizeOptions(dto);
    const pages: FlyerAssemblyPagePlanDto[] = [];
    const groups = this.groupProductsByCategory(products);
    const pageLimit = options.allowMultiplePages
      ? options.maxProductsPerPage
      : Math.max(products.length, options.maxProductsPerPage);
    let currentPage: FlyerAssemblyPagePlanDto = { name: 'Pagina 1', sections: [] };
    let currentPageProductCount = 0;

    const pushCurrentPage = () => {
      if (currentPage.sections.length === 0) return;
      pages.push(currentPage);
      currentPage = { name: `Pagina ${pages.length + 1}`, sections: [] };
      currentPageProductCount = 0;
    };

    for (const group of groups) {
      const chunks = this.chunk(group.products, Math.max(1, pageLimit));

      for (const chunk of chunks) {
        if (
          options.allowMultiplePages &&
          currentPage.sections.length > 0 &&
          currentPageProductCount + chunk.length > pageLimit
        ) {
          pushCurrentPage();
        }

        const layout = this.chooseLayout(chunk, options.layoutDensity, currentPage.sections.length);
        currentPage.sections.push({
          category: group.category,
          title: group.category,
          priority: this.getCategoryPriority(group.category, chunk.length),
          layout,
          productIds: chunk.map((product) => product.id),
          featuredProductIds: this.chooseFeaturedProducts(chunk, layout),
        });
        currentPageProductCount += chunk.length;
      }
    }

    pushCurrentPage();

    return this.buildResponse(
      pages.length > 0 ? pages : [{ name: 'Pagina 1', sections: [] }],
      [],
      products,
      notes,
      'fallback',
    );
  }

  private sanitizePlan(
    plan: FlyerAssemblyPlanSchemaResult,
    products: FlyerAssemblyProductDto[],
    dto: FlyerAssemblyPlanRequestDto,
  ): FlyerAssemblyPlanSchemaResult {
    const productById = new Map(products.map((product) => [product.id, product]));
    const usedProductIds = new Set<string>();
    const notes = [...(plan.notes || [])];
    const pages: FlyerAssemblyPagePlanDto[] = [];

    plan.pages.forEach((page, pageIndex) => {
      const sections: FlyerAssemblySectionPlanDto[] = [];

      page.sections.forEach((section) => {
        const productIds: string[] = [];

        section.productIds.forEach((productId) => {
          if (!productById.has(productId)) {
            notes.push(`Produto desconhecido ignorado: ${productId}.`);
            return;
          }

          if (usedProductIds.has(productId)) {
            notes.push(`Produto duplicado ignorado: ${productId}.`);
            return;
          }

          usedProductIds.add(productId);
          productIds.push(productId);
        });

        if (productIds.length === 0) {
          return;
        }

        const productIdSet = new Set(productIds);
        const featuredProductIds = section.featuredProductIds.filter((productId, index, list) => {
          const product = productById.get(productId);

          return (
            productIdSet.has(productId) &&
            list.indexOf(productId) === index &&
            Boolean(product?.hasImage) &&
            product?.imageQuality !== 'poor' &&
            product?.imageQuality !== 'missing'
          );
        });

        sections.push({
          category: this.normalizeCategory(section.category),
          title: section.title.trim() || this.normalizeCategory(section.category),
          priority: Number.isFinite(section.priority) ? section.priority : 0,
          layout: ALLOWED_LAYOUTS.includes(section.layout) ? section.layout : 'balanced-grid',
          productIds,
          featuredProductIds,
        });
      });

      if (sections.length > 0) {
        pages.push({
          name: page.name?.trim() || `Pagina ${pageIndex + 1}`,
          sections,
        });
      }
    });

    const explicitUnplaced = new Set(
      plan.unplacedProductIds.filter((productId) => productById.has(productId)),
    );
    const missingProducts = products.filter(
      (product) => !usedProductIds.has(product.id) && !explicitUnplaced.has(product.id),
    );

    if (missingProducts.length > 0) {
      if (dto.options?.allowMultiplePages === false) {
        missingProducts.forEach((product) => explicitUnplaced.add(product.id));
        notes.push(`${missingProducts.length} produto(s) ficaram fora por limite de pagina.`);
      } else {
        const fallbackForMissing = this.createFallbackPlan(dto, missingProducts, []).pages;
        pages.push(...fallbackForMissing);
        missingProducts.forEach((product) => usedProductIds.add(product.id));
        notes.push(`${missingProducts.length} produto(s) ausentes foram adicionados por fallback.`);
      }
    }

    if (pages.length === 0) {
      const fallback = this.createFallbackPlan(dto, products, notes);
      return {
        pages: fallback.pages,
        unplacedProductIds: fallback.unplacedProductIds,
        notes: fallback.notes,
      };
    }

    return {
      pages,
      unplacedProductIds: [...explicitUnplaced],
      notes,
    };
  }

  private buildResponse(
    pages: FlyerAssemblyPagePlanDto[],
    unplacedProductIds: string[],
    products: FlyerAssemblyProductDto[],
    notes: string[],
    source: FlyerAssemblyPlanSource,
  ): FlyerAssemblyPlanResponseDto {
    const placedProductIds = new Set(
      pages.flatMap((page) => page.sections.flatMap((section) => section.productIds)),
    );

    return {
      pages,
      unplacedProductIds,
      notes,
      summary: {
        totalProducts: products.length,
        placedProducts: placedProductIds.size,
        unplacedProducts: unplacedProductIds.length,
        pageCount: pages.length,
        source,
      },
    };
  }

  private groupProductsByCategory(products: FlyerAssemblyProductDto[]) {
    const groups = new Map<string, FlyerAssemblyProductDto[]>();

    products.forEach((product) => {
      const category = this.normalizeCategory(product.category);
      groups.set(category, [...(groups.get(category) || []), product]);
    });

    return [...groups.entries()]
      .map(([category, groupedProducts]) => ({
        category,
        products: groupedProducts,
      }))
      .sort((a, b) => {
        const orderA = this.getCategoryOrder(a.category);
        const orderB = this.getCategoryOrder(b.category);
        if (orderA !== orderB) return orderA - orderB;
        return b.products.length - a.products.length;
      });
  }

  private normalizeProducts(products: FlyerAssemblyProductDto[]): FlyerAssemblyProductDto[] {
    const seen = new Set<string>();
    const normalized: FlyerAssemblyProductDto[] = [];

    products.forEach((product) => {
      if (!product.id || seen.has(product.id)) return;
      seen.add(product.id);
      normalized.push({
        ...product,
        name: product.name.trim(),
        unit: product.unit?.trim() || 'un',
        category: this.normalizeCategory(product.category),
        hasImage: Boolean(product.hasImage),
      });
    });

    return normalized;
  }

  private normalizeOptions(dto: FlyerAssemblyPlanRequestDto) {
    const density = dto.options?.layoutDensity || 'balanced';
    return {
      maxProductsPerPage:
        dto.options?.maxProductsPerPage ||
        this.getDefaultProductsPerPageForDensity(density),
      allowMultiplePages: dto.options?.allowMultiplePages !== false,
      preserveCategorySections: dto.options?.preserveCategorySections !== false,
      layoutDensity: density,
    };
  }

  private chooseLayout(
    products: FlyerAssemblyProductDto[],
    density: FlyerAssemblyLayoutDensity,
    sectionIndex: number,
  ): FlyerAssemblySectionLayout {
    if (
      density === 'premium' &&
      sectionIndex === 0 &&
      products.length >= 3 &&
      products.some((product) => product.hasImage)
    ) {
      return 'hero-grid';
    }

    if (density === 'dense' || products.length >= 16) {
      return 'dense-grid';
    }

    return 'balanced-grid';
  }

  private chooseFeaturedProducts(
    products: FlyerAssemblyProductDto[],
    layout: FlyerAssemblySectionLayout,
  ): string[] {
    if (layout !== 'hero-grid') {
      return [];
    }

    return [...products]
      .sort((a, b) => Number(b.hasImage) - Number(a.hasImage) || b.price - a.price)
      .slice(0, 1)
      .map((product) => product.id);
  }

  private getCategoryPriority(category: string, productCount: number): number {
    return Math.max(1, 100 - this.getCategoryOrder(category) * 5 + productCount);
  }

  private getCategoryOrder(category: string): number {
    const comparable = this.normalizeComparableText(category);
    const index = COMMERCIAL_CATEGORY_ORDER.findIndex(
      (candidate) => this.normalizeComparableText(candidate) === comparable,
    );
    return index >= 0 ? index : COMMERCIAL_CATEGORY_ORDER.length;
  }

  private getDefaultProductsPerPageForDensity(density: FlyerAssemblyLayoutDensity): number {
    if (density === 'dense') return 60;
    if (density === 'premium') return 24;
    return DEFAULT_MAX_PRODUCTS_PER_PAGE;
  }

  private normalizeCategory(category?: string | null): string {
    return category?.trim() || DEFAULT_CATEGORY;
  }

  private normalizeComparableText(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private isEnabled(): boolean {
    const value = this.configService.get<string>('AI_FLYER_ASSEMBLY_ENABLED');
    return value === undefined || value === 'true' || value === '1';
  }

  private getPositiveIntegerConfig(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

        const reason = error instanceof Error ? error.message : String(error);
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
}
