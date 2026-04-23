import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { UploadsService } from '../uploads/uploads.service';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  CurrentLayerElementDto,
  LayerElementDto,
  TemplateLayersFormatDto,
  TemplateLayersGenerateResponseDto,
  TemplateLayersMessageDto,
} from './dto/template-layers-generate.dto';
import { OpenAiImageInput, OpenAiImageService } from './openai-image.service';
import {
  AI_RESPONSE_FORMATS,
  ImageIntentCategory,
  TemplateLayersCompositionSchemaResult,
  parseImageIntentClassification,
  parseTemplateLayersComposition,
} from './schemas/ai-response.schemas';
import { IMAGE_INTENT_CLASSIFICATION_SYSTEM_PROMPT } from './prompts/image-intent.prompts';
import {
  TEMPLATE_LAYERS_REFERENCE_VISION_PROMPT,
  buildLayerIntentInstruction,
  buildTemplateLayersCompositionSystemPrompt,
} from './prompts/template-layers.prompts';
import {
  OpenAiImageSize,
  materializeGeneratedImage,
  selectImageSizeByAspectRatio,
  uploadGeneratedAsset,
} from './utils/ai-image.util';
import {
  LayoutNormalizationAdjustment,
  normalizeLayerBackgrounds,
  normalizeLayerElements,
} from './utils/ai-layout.util';
import { withAiLogging } from './utils/ai-telemetry.util';

interface ImageIntentClassification {
  category: ImageIntentCategory;
  confidence: number;
  shouldGenerateImage: boolean;
  shouldEditExistingImage: boolean;
  shouldUseLayerFlow: boolean;
  shouldPreserveExistingImage: boolean;
  reason?: string;
}

interface ImageIntentContext {
  feature: string;
  userMessage: string;
  hasExistingImage: boolean;
  hasReferenceImages: boolean;
  hasCurrentLayers?: boolean;
}

type LayerCompositionMode =
  | 'hero-left'
  | 'hero-right'
  | 'center-stage'
  | 'editorial-banner';

type LayerElementZone =
  | 'hero-left'
  | 'hero-right'
  | 'center-stage'
  | 'title-band-left'
  | 'title-band-center'
  | 'title-band-right'
  | 'top-left-accent'
  | 'top-right-accent'
  | 'bottom-left-accent'
  | 'bottom-right-accent'
  | 'footer-left'
  | 'footer-center'
  | 'footer-right'
  | 'footer-band';

type LayerElementRole = 'hero' | 'support' | 'accent';
type VisualStrategy = 'decorative-template' | 'retail-scene';

@Injectable()
export class TemplateLayersGeneratorService {
  private readonly logger = new Logger(TemplateLayersGeneratorService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
    private readonly openAiImageService: OpenAiImageService,
  ) {
    this.models = getOpenAiModelConfig(configService);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async generateTemplateLayers(
    format: TemplateLayersFormatDto,
    messages: TemplateLayersMessageDto[],
  ): Promise<TemplateLayersGenerateResponseDto> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) throw new Error('Nenhuma mensagem do usuário encontrada');

    const userReferenceImages = lastUserMessage.images ?? [];

    // Current layers state (for refinements — preserves elements not being changed)
    const currentLayers = lastUserMessage.currentLayers ?? { elements: [] };
    const isRefinement = currentLayers.elements.length > 0 || !!currentLayers.background;
    const imageIntent = await this.classifyImageIntent({
      feature: 'template-layers.intent',
      userMessage: lastUserMessage.content,
      hasExistingImage: !!currentLayers.background,
      hasReferenceImages: userReferenceImages.length > 0,
      hasCurrentLayers: isRefinement,
    });
    const shouldPreserveLayerAssets = imageIntent.shouldPreserveExistingImage && isRefinement;
    const referenceImageInputs = shouldPreserveLayerAssets
      ? []
      : await this.materializeReferenceImageInputs(userReferenceImages, 'template-layers');

    // ── Step 1: Vision analysis of reference images (same as F5) ─────────────
    let referenceStyleDescription = '';
    if (userReferenceImages.length > 0) {
      type VisionPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

      const visionContent: VisionPart[] = [
        {
          type: 'text',
          text: TEMPLATE_LAYERS_REFERENCE_VISION_PROMPT,
        },
        ...userReferenceImages.map(
          (img): VisionPart => ({
            type: 'image_url',
            image_url: { url: img, detail: 'high' },
          }),
        ),
      ];

      const visionResponse = await withAiLogging(
        this.logger,
        {
          feature: 'template-layers.reference-vision',
          endpoint: 'chat.completions',
          model: this.models.textModel,
        },
        () =>
          this.openai!.chat.completions.create({
            model: this.models.textModel,
            max_tokens: 400,
            messages: [{ role: 'user', content: visionContent }],
          }),
      );
      referenceStyleDescription = visionResponse.choices[0]?.message?.content?.trim() ?? '';
    }

    // ── Step 2: GPT-4o decides the composition (palette + elements) ──────────
    const canvasWidthPx = Math.round(format.printWidthCm * 37.795);
    const headerHeightPx = Math.round(format.headerHeightCm * 37.795);
    const footerHeightPx = Math.round(format.footerHeightCm * 37.795);
    const visualStrategy = this.detectVisualStrategy(
      lastUserMessage.content,
      referenceStyleDescription,
    );
    const intentInstruction = buildLayerIntentInstruction({
      category: imageIntent.category,
      isRefinement,
    });
    const strategyInstruction = this.buildStrategyInstruction(
      visualStrategy,
      lastUserMessage.content,
    );

    const compositionSystemPrompt = buildTemplateLayersCompositionSystemPrompt({
      canvasWidthPx,
      headerHeightPx,
      footerHeightPx,
      referenceStyleDescription,
      intentInstruction,
      strategyInstruction,
      isRefinement,
      currentLayers,
    });

    const composition: TemplateLayersCompositionSchemaResult =
      await this.createStructuredChatCompletion({
        feature: 'template-layers.composition',
        model: this.models.textModel,
        emptyResponseMessage: 'GPT-4o retornou composição vazia',
        parse: parseTemplateLayersComposition,
        request: {
          model: this.models.textModel,
          max_tokens: 1000,
          temperature: 0.4,
          response_format: AI_RESPONSE_FORMATS.templateLayersComposition,
          messages: [
            { role: 'system', content: compositionSystemPrompt },
            { role: 'user', content: lastUserMessage.content },
          ],
        },
      });
    const styleKeywords = Array.isArray(composition.styleKeywords)
      ? composition.styleKeywords.filter((item): item is string => typeof item === 'string')
      : [];
    const avoidTerms = Array.isArray(composition.avoid)
      ? composition.avoid.filter((item): item is string => typeof item === 'string')
      : [];
    const styleSuffix = styleKeywords.length
      ? `, style keywords: ${styleKeywords.slice(0, 8).join(', ')}`
      : '';
    const avoidSuffix = avoidTerms.length
      ? `, avoid: ${avoidTerms.slice(0, 8).join(', ')}`
      : ', avoid readable text, logos, prices, labels, busy product card area';

    // ── Step 3: Generate background + transparent element PNGs in parallel ────
    const bgSize = selectImageSizeByAspectRatio(format.printWidthCm, format.headerHeightCm, {
      portraitMaxRatio: 0.77,
      landscapeMinRatio: 1.3,
    });

    const preserveCurrentBackground =
      isRefinement &&
      !!currentLayers.background &&
      (imageIntent.category === 'text_change' ||
        imageIntent.category === 'layout_change' ||
        imageIntent.category === 'add_layer_element' ||
        imageIntent.category === 'replace_layer_element');

    const needsNewBackground =
      !preserveCurrentBackground &&
      (!isRefinement ||
        !currentLayers.background ||
        composition.elements.every((e) => e.regenerate !== false)); // full redo

    const bgPrompt = this.buildLayerBackgroundPrompt(
      composition.backgroundPrompt,
      styleSuffix,
      avoidSuffix,
    );

    const bgPromise = needsNewBackground
      ? this.generateAndUploadLayerImage(
          bgPrompt,
          bgSize,
          format.type,
          'bg',
          false,
          referenceImageInputs,
        )
      : Promise.resolve(currentLayers.background!.imageUrl);

    const preserveCurrentElementsExactly = imageIntent.category === 'text_change' && isRefinement;

    // Max 4 elements
    const elementsToProcess = preserveCurrentElementsExactly
      ? []
      : composition.elements.slice(0, 5);

    const elementPromises = elementsToProcess.map(async (el) => {
      if (isRefinement && imageIntent.category === 'layout_change') {
        const existing = currentLayers.elements.find((e) => e.id === el.id);
        if (existing) {
          return {
            id: el.id,
            imageUrl: existing.imageUrl,
            prompt: el.englishPrompt,
            section: el.section,
          };
        }
      }

      // If position-only change, preserve existing imageUrl
      if (isRefinement && el.positionOnly) {
        const existing = currentLayers.elements.find((e) => e.id === el.id);
        if (existing) {
          return {
            id: el.id,
            imageUrl: existing.imageUrl,
            prompt: el.englishPrompt,
            section: el.section,
          };
        }
      }
      // If refinement and this element hasn't changed, preserve URL
      if (isRefinement && el.regenerate === false) {
        const existing = currentLayers.elements.find((e) => e.id === el.id);
        if (existing) {
          return {
            id: el.id,
            imageUrl: existing.imageUrl,
            prompt: el.englishPrompt,
            section: el.section,
          };
        }
      }
      // Generate new transparent PNG
      const transparentPrompt = this.buildTransparentElementPrompt(
        el.englishPrompt,
        el.role,
        styleSuffix,
        avoidSuffix,
      );
      const imageUrl = await this.generateAndUploadLayerImage(
        transparentPrompt,
        '1024x1024',
        format.type,
        el.id,
        true,
        referenceImageInputs,
      );
      return { id: el.id, imageUrl, prompt: el.englishPrompt, section: el.section };
    });

    const [bgUrl, ...generatedElements] = await Promise.all([bgPromise, ...elementPromises]);

    // ── Step 4: Convert suggestedPosition + sizePct → real canvas coordinates ─
    const rawLayerElements: LayerElementDto[] = preserveCurrentElementsExactly
      ? this.mapCurrentLayerElements(currentLayers.elements)
      : generatedElements.map((el, idx) => {
          const elDef = elementsToProcess[idx];
          const placement = this.resolveLayerPlacement({
            canvasWidthPx,
            headerHeightPx,
            footerHeightPx,
            compositionMode: composition.compositionMode,
            heroElementId: composition.heroElementId,
            elementId: elDef.id,
            section: elDef.section,
            role: elDef.role,
            zone: elDef.zone,
            suggestedPosition: elDef.suggestedPosition,
            suggestedSizePct: elDef.suggestedSizePct,
          });

          return {
            id: el.id,
            imageUrl: el.imageUrl,
            prompt: el.prompt,
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
            section: elDef.section,
            zIndex: idx + 1,
          };
        });
    const normalizedLayerElements = normalizeLayerElements(rawLayerElements, {
      canvasWidthPx,
      headerHeightPx,
      footerHeightPx,
    });
    const normalizedBackgrounds = normalizeLayerBackgrounds(
      composition.bodyBackground,
      composition.footerBackground,
    );
    this.logLayoutNormalization('template-layers.layout', [
      ...normalizedLayerElements.adjustments,
      ...normalizedBackgrounds.adjustments,
    ]);

    return {
      assistantMessage: composition.assistantMessagePt || 'Template em camadas gerado com sucesso!',
      layers: {
        background: {
          imageUrl: bgUrl,
          prompt: composition.backgroundPrompt,
        },
        elements: normalizedLayerElements.elements,
      },
      bodyBackground: normalizedBackgrounds.bodyBackground,
      footerBackground: normalizedBackgrounds.footerBackground,
    };
  }

  private async createStructuredChatCompletion<T>(options: {
    feature: string;
    model: string;
    request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    parse: (raw: string) => T;
    emptyResponseMessage: string;
  }): Promise<T> {
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

  private logLayoutNormalization(
    feature: string,
    adjustments: LayoutNormalizationAdjustment[],
  ): void {
    if (!adjustments.length) return;

    this.logger.warn(
      `AI layout normalized ${JSON.stringify({
        feature,
        corrections: adjustments.length,
        adjustments: adjustments.slice(0, 20),
      })}`,
    );
  }

  private async materializeReferenceImageInputs(
    images: string[],
    feature: string,
    limit = 5,
  ): Promise<OpenAiImageInput[]> {
    const limitedImages = images.slice(0, limit);
    if (!limitedImages.length) {
      return [];
    }

    const inputs = await Promise.all(
      limitedImages.map(async (image, index) => {
        const materialized = await materializeGeneratedImage(image, 'image/png');
        return {
          buffer: materialized.buffer,
          mimeType: materialized.mimeType,
          filename: `reference-${index + 1}${materialized.extension}`,
        };
      }),
    );

    this.logger.log(
      `Reference images prepared ${JSON.stringify({
        feature,
        count: inputs.length,
      })}`,
    );

    return inputs;
  }

  private async classifyImageIntent(
    context: ImageIntentContext,
  ): Promise<ImageIntentClassification> {
    const fallback = this.getFallbackImageIntent(context);
    if (!this.openai) return fallback;

    try {
      const parsed = await this.createStructuredChatCompletion({
        feature: context.feature,
        model: this.models.fastTextModel,
        emptyResponseMessage: 'Resposta vazia da classificação de intenção',
        parse: parseImageIntentClassification,
        request: {
          model: this.models.fastTextModel,
          response_format: AI_RESPONSE_FORMATS.imageIntentClassification,
          max_tokens: 300,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: IMAGE_INTENT_CLASSIFICATION_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: JSON.stringify({
                message: context.userMessage,
                hasExistingImage: context.hasExistingImage,
                hasReferenceImages: context.hasReferenceImages,
                hasCurrentLayers: !!context.hasCurrentLayers,
              }),
            },
          ],
        },
      });
      const confidence = parsed.confidence;

      if (confidence < 0.55) {
        this.logImageIntentClassification(context, fallback, 'low-confidence-fallback');
        return fallback;
      }

      const classified = this.buildImageIntentClassification(
        parsed.category,
        confidence,
        context,
        parsed.reason,
      );
      this.logImageIntentClassification(context, classified, 'classified');
      return classified;
    } catch (error) {
      this.logger.warn(
        `Image intent classification failed ${JSON.stringify({
          feature: context.feature,
          error: (error as Error).message,
        })}`,
      );
      return fallback;
    }
  }

  private getFallbackImageIntent(context: ImageIntentContext): ImageIntentClassification {
    const category: ImageIntentCategory = context.hasExistingImage
      ? 'targeted_edit'
      : context.hasReferenceImages
        ? 'style_variation'
        : 'new_full_image';

    return this.buildImageIntentClassification(category, 0, context, 'fallback');
  }

  private buildImageIntentClassification(
    category: ImageIntentCategory,
    confidence: number,
    context: ImageIntentContext,
    reason?: string,
  ): ImageIntentClassification {
    const canPreserve = context.hasExistingImage || !!context.hasCurrentLayers;
    const hasImageInput = context.hasExistingImage || context.hasReferenceImages;

    switch (category) {
      case 'text_change':
      case 'layout_change':
        return {
          category,
          confidence,
          shouldGenerateImage: !canPreserve,
          shouldEditExistingImage: false,
          shouldUseLayerFlow: false,
          shouldPreserveExistingImage: canPreserve,
          reason,
        };
      case 'add_layer_element':
      case 'replace_layer_element':
        return {
          category,
          confidence,
          shouldGenerateImage: true,
          shouldEditExistingImage: hasImageInput,
          shouldUseLayerFlow: true,
          shouldPreserveExistingImage: false,
          reason,
        };
      case 'targeted_edit':
        return {
          category,
          confidence,
          shouldGenerateImage: !context.hasExistingImage,
          shouldEditExistingImage: context.hasExistingImage,
          shouldUseLayerFlow: false,
          shouldPreserveExistingImage: false,
          reason,
        };
      case 'style_variation':
        return {
          category,
          confidence,
          shouldGenerateImage: !hasImageInput,
          shouldEditExistingImage: hasImageInput,
          shouldUseLayerFlow: false,
          shouldPreserveExistingImage: false,
          reason,
        };
      case 'new_full_image':
      default:
        return {
          category: 'new_full_image',
          confidence,
          shouldGenerateImage: true,
          shouldEditExistingImage: false,
          shouldUseLayerFlow: false,
          shouldPreserveExistingImage: false,
          reason,
        };
    }
  }

  private logImageIntentClassification(
    context: ImageIntentContext,
    intent: ImageIntentClassification,
    status: string,
  ): void {
    this.logger.log(
      `Image intent ${JSON.stringify({
        feature: context.feature,
        status,
        category: intent.category,
        confidence: intent.confidence,
        hasExistingImage: context.hasExistingImage,
        hasReferenceImages: context.hasReferenceImages,
        hasCurrentLayers: !!context.hasCurrentLayers,
        shouldGenerateImage: intent.shouldGenerateImage,
        shouldEditExistingImage: intent.shouldEditExistingImage,
        shouldUseLayerFlow: intent.shouldUseLayerFlow,
        shouldPreserveExistingImage: intent.shouldPreserveExistingImage,
      })}`,
    );
  }

  private mapCurrentLayerElements(elements: CurrentLayerElementDto[]): LayerElementDto[] {
    return elements.map(
      (element, index): LayerElementDto => ({
        id: element.id,
        imageUrl: element.imageUrl,
        prompt: element.prompt,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
        section: element.section === 'footer' ? 'footer' : 'header',
        zIndex: index + 1,
      }),
    );
  }

  private async generateAndUploadLayerImage(
    prompt: string,
    size: OpenAiImageSize,
    formatType: string,
    suffix: string,
    transparent = false,
    referenceImages: OpenAiImageInput[] = [],
  ): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const generated =
      referenceImages.length > 0
        ? await this.openAiImageService.editImage({
            feature: transparent
              ? 'template-layers.element-image.reference'
              : 'template-layers.background-image.reference',
            prompt,
            images: referenceImages,
            size,
            assetKind: transparent ? 'transparent' : 'background',
            mode: 'final',
            inputFidelity: this.models.imageInputFidelity,
          })
        : await this.openAiImageService.generateImage({
            feature: transparent
              ? 'template-layers.element-image'
              : 'template-layers.background-image',
            prompt,
            size,
            assetKind: transparent ? 'transparent' : 'background',
            mode: 'final',
          });

    const ext = transparent ? '.png' : generated.image.extension;
    const slug = this.slugify(formatType);
    const filename = `ai-layer-${slug}-${suffix}-${Date.now()}${ext}`;

    const uploaded = await uploadGeneratedAsset({
      buffer: generated.image.buffer,
      filename,
      mimeType: transparent ? 'image/png' : generated.image.mimeType,
      folder: 'templates',
      uploadsService: this.uploadsService,
    });
    return uploaded.url;
  }

  private slugify(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private detectVisualStrategy(
    userMessage: string,
    referenceStyleDescription: string,
  ): VisualStrategy {
    const haystack = `${userMessage} ${referenceStyleDescription}`.toLowerCase();
    const retailSceneSignals = [
      'supermercado',
      'supermarket',
      'corredor',
      'aisle',
      'prateleira',
      'shelves',
      'frutas',
      'legumes',
      'vegetables',
      'mulher',
      'woman',
      'homem',
      'person',
      'people',
      'shopping bag',
      'sacola',
      'realista',
      'realistic',
      'photorealistic',
      'store interior',
      'loja',
      'environment',
      'scene',
      'cenario',
      'cenário',
    ];

    return retailSceneSignals.some((signal) => haystack.includes(signal))
      ? 'retail-scene'
      : 'decorative-template';
  }

  private buildStrategyInstruction(
    strategy: VisualStrategy,
    userMessage: string,
  ): string {
    if (strategy === 'retail-scene') {
      const normalized = userMessage.toLowerCase();
      const preferredSide =
        normalized.includes('lado esquerdo') || normalized.includes(' left')
          ? 'hero-left'
          : normalized.includes('lado direito') || normalized.includes(' right')
            ? 'hero-right'
            : 'hero-left';

      return `
VISUAL STRATEGY: retail-scene.
- Treat this request as a realistic supermarket campaign scene adapted into an editable flyer header.
- The header background should behave like a real environment plate or campaign scene, not a generic decorative texture.
- Prefer compositionMode "${preferredSide}" unless the user explicitly asks for a centered hero.
- If the user mentions a person, shopper, woman, man, character, or spokesperson, include one clear hero subject with strong visual presence.
- Hero scale must feel substantial and commercial, never like a tiny sticker.
- Support/accent elements must remain subordinate to the hero and to the environment scene.
- Body background should avoid plain empty white when the request asks for realism; prefer a subtle commercial gradient or subtle derived texture.
- Footer should feel intentional and branded, not like a generic dark strip.`;
    }

    return `
VISUAL STRATEGY: decorative-template.
- Treat this request as a professional layered retail template with one strong hero plus controlled support/accent elements.
- Avoid repetitive layouts with tiny floating objects and generic dark footer bars.`;
  }

  private buildLayerBackgroundPrompt(
    basePrompt: string,
    styleSuffix: string,
    avoidSuffix: string,
  ): string {
    return [
      basePrompt,
      'professional supermarket flyer header key visual',
      'commercial art direction',
      'clean editable text-safe area preserved',
      'no readable text',
      'no logos',
      'no prices',
      'no labels',
      'no typographic artwork unless explicitly requested',
      'avoid tiny floating objects',
      'avoid empty header composition',
      styleSuffix ? styleSuffix.trim().replace(/^,/, '') : '',
      avoidSuffix ? avoidSuffix.trim().replace(/^,/, '') : '',
    ]
      .filter(Boolean)
      .join(', ');
  }

  private buildTransparentElementPrompt(
    basePrompt: string,
    role: LayerElementRole,
    styleSuffix: string,
    avoidSuffix: string,
  ): string {
    const roleInstruction =
      role === 'hero'
        ? 'isolated hero subject with strong commercial presence'
        : role === 'support'
          ? 'isolated supporting visual element'
          : 'isolated accent detail';

    return [
      basePrompt,
      roleInstruction,
      'transparent background',
      'no shadow on floor',
      'no background',
      'no readable text',
      'no logo',
      'no label',
      'no price tag',
      'high quality PNG cutout',
      styleSuffix ? styleSuffix.trim().replace(/^,/, '') : '',
      avoidSuffix ? avoidSuffix.trim().replace(/^,/, '') : '',
    ]
      .filter(Boolean)
      .join(', ');
  }

  private resolveLayerPlacement(options: {
    canvasWidthPx: number;
    headerHeightPx: number;
    footerHeightPx: number;
    compositionMode: LayerCompositionMode;
    heroElementId?: string;
    elementId: string;
    section: 'header' | 'footer';
    role: LayerElementRole;
    zone: LayerElementZone;
    suggestedPosition: string;
    suggestedSizePct: number;
  }): { x: number; y: number; width: number; height: number } {
    const sectionHeightPx =
      options.section === 'header' ? options.headerHeightPx : options.footerHeightPx;
    const isHero = options.role === 'hero' || options.elementId === options.heroElementId;
    const sizePct = this.resolveElementSizePct(options.suggestedSizePct, options.role, isHero);
    const width = Math.round((sizePct / 100) * options.canvasWidthPx);
    const height = Math.round(width * this.resolveAspectRatio(options.role, options.section));
    const marginX = Math.round(options.canvasWidthPx * 0.05);
    const marginY = Math.round(sectionHeightPx * 0.08);
    const maxX = Math.max(0, options.canvasWidthPx - width - marginX);
    const maxY = Math.max(0, sectionHeightPx - height - marginY);

    const fallbackZone = this.fallbackZoneForComposition(
      options.compositionMode,
      options.section,
      options.role,
      options.suggestedPosition,
    );
    const zone = options.zone ?? fallbackZone;

    switch (zone) {
      case 'hero-left':
        return {
          x: marginX,
          y: Math.round(Math.min(maxY, sectionHeightPx * 0.1)),
          width,
          height,
        };
      case 'hero-right':
        return {
          x: Math.max(marginX, options.canvasWidthPx - width - marginX),
          y: Math.round(Math.min(maxY, sectionHeightPx * 0.1)),
          width,
          height,
        };
      case 'center-stage':
        return {
          x: Math.round((options.canvasWidthPx - width) / 2),
          y: Math.round((sectionHeightPx - height) / 2),
          width,
          height,
        };
      case 'title-band-left':
        return {
          x: marginX,
          y: Math.round(Math.min(maxY, sectionHeightPx * 0.18)),
          width,
          height,
        };
      case 'title-band-center':
        return {
          x: Math.round((options.canvasWidthPx - width) / 2),
          y: Math.round(Math.min(maxY, sectionHeightPx * 0.16)),
          width,
          height,
        };
      case 'title-band-right':
        return {
          x: Math.max(marginX, options.canvasWidthPx - width - marginX),
          y: Math.round(Math.min(maxY, sectionHeightPx * 0.18)),
          width,
          height,
        };
      case 'top-left-accent':
        return { x: marginX, y: marginY, width, height };
      case 'top-right-accent':
        return {
          x: Math.max(marginX, options.canvasWidthPx - width - marginX),
          y: marginY,
          width,
          height,
        };
      case 'bottom-left-accent':
        return {
          x: marginX,
          y: Math.max(marginY, sectionHeightPx - height - marginY),
          width,
          height,
        };
      case 'bottom-right-accent':
        return {
          x: Math.max(marginX, options.canvasWidthPx - width - marginX),
          y: Math.max(marginY, sectionHeightPx - height - marginY),
          width,
          height,
        };
      case 'footer-left':
        return {
          x: marginX,
          y: Math.round((sectionHeightPx - height) / 2),
          width,
          height,
        };
      case 'footer-center':
      case 'footer-band':
        return {
          x: Math.round((options.canvasWidthPx - width) / 2),
          y: Math.round((sectionHeightPx - height) / 2),
          width,
          height,
        };
      case 'footer-right':
        return {
          x: Math.max(marginX, options.canvasWidthPx - width - marginX),
          y: Math.round((sectionHeightPx - height) / 2),
          width,
          height,
        };
      default:
        return {
          x: Math.round((options.canvasWidthPx - width) / 2),
          y: Math.round((sectionHeightPx - height) / 2),
          width,
          height,
        };
    }
  }

  private resolveElementSizePct(
    requestedSizePct: number,
    role: LayerElementRole,
    isHero: boolean,
  ): number {
    if (isHero) {
      return Math.max(28, Math.min(58, requestedSizePct || 40));
    }
    if (role === 'support') {
      return Math.max(16, Math.min(30, requestedSizePct || 22));
    }
    return Math.max(8, Math.min(16, requestedSizePct || 12));
  }

  private resolveAspectRatio(role: LayerElementRole, section: 'header' | 'footer'): number {
    if (role === 'hero') {
      return section === 'header' ? 1.08 : 0.95;
    }
    if (role === 'support') {
      return 0.88;
    }
    return 0.72;
  }

  private fallbackZoneForComposition(
    compositionMode: LayerCompositionMode,
    section: 'header' | 'footer',
    role: LayerElementRole,
    suggestedPosition: string,
  ): LayerElementZone {
    if (section === 'footer') {
      if (suggestedPosition === 'left') return 'footer-left';
      if (suggestedPosition === 'right') return 'footer-right';
      return role === 'accent' ? 'footer-band' : 'footer-center';
    }

    if (role === 'hero') {
      if (compositionMode === 'hero-right') return 'hero-right';
      if (compositionMode === 'center-stage') return 'center-stage';
      return 'hero-left';
    }

    if (suggestedPosition === 'top') return 'title-band-center';
    if (suggestedPosition === 'left') return 'top-left-accent';
    if (suggestedPosition === 'right') return 'top-right-accent';
    if (suggestedPosition === 'bottom-left') return 'bottom-left-accent';
    if (suggestedPosition === 'bottom-right') return 'bottom-right-accent';

    return compositionMode === 'hero-right' ? 'top-left-accent' : 'top-right-accent';
  }
}
