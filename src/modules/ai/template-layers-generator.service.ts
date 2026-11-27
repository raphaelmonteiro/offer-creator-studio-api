import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { UploadsService } from '../uploads/uploads.service';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  IMAGE_INTENT_CALL,
  TEMPLATE_LAYERS_COMPOSITION_CALL,
  TEMPLATE_LAYERS_REFERENCE_CALL,
} from './config/openai-text-calls';
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
import { callProductChat } from './utils/ai-product-chat.util';
import { createStructuredChatCompletion } from './utils/ai-structured-chat.util';

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

      const visionResponse = await callProductChat({
        openai: this.openai,
        logger: this.logger,
        feature: 'template-layers.reference-vision',
        spec: { model: this.models.textModel, ...TEMPLATE_LAYERS_REFERENCE_CALL },
        messages: [{ role: 'user', content: visionContent }],
      });
      referenceStyleDescription = visionResponse.choices[0]?.message?.content?.trim() ?? '';
    }

    // ── Step 2: the text model decides the composition (palette + elements) ──
    const canvasWidthPx = Math.round(format.printWidthCm * 37.795);
    const headerHeightPx = Math.round(format.headerHeightCm * 37.795);
    const footerHeightPx = Math.round(format.footerHeightCm * 37.795);
    const intentInstruction = buildLayerIntentInstruction({
      category: imageIntent.category,
      isRefinement,
    });

    const compositionSystemPrompt = buildTemplateLayersCompositionSystemPrompt({
      canvasWidthPx,
      headerHeightPx,
      footerHeightPx,
      referenceStyleDescription,
      intentInstruction,
      isRefinement,
      currentLayers,
    });

    const composition: TemplateLayersCompositionSchemaResult = await createStructuredChatCompletion(
      {
        openai: this.openai,
        logger: this.logger,
        feature: 'template-layers.composition',
        spec: { model: this.models.textModel, ...TEMPLATE_LAYERS_COMPOSITION_CALL },
        messages: [
          { role: 'system', content: compositionSystemPrompt },
          { role: 'user', content: lastUserMessage.content },
        ],
        responseFormat: AI_RESPONSE_FORMATS.templateLayersComposition,
        parse: parseTemplateLayersComposition,
        emptyResponseMessage: 'A IA retornou composição vazia',
        retryAttempts: this.models.structuredResponseRetryAttempts,
      },
    );
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
    const bgSize = selectImageSizeByAspectRatio(format.printWidthCm, format.printHeightCm, {
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

    const bgPromise = needsNewBackground
      ? this.generateAndUploadLayerImage(
          `${composition.backgroundPrompt}, promotional flyer header background, subtle texture, clean editable text safe area, no readable text, no logos, no prices, no labels, no objects covering the central text overlay area, seamless texture${styleSuffix}${avoidSuffix}`,
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
      : composition.elements.slice(0, 4);

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
      const transparentPrompt = `${el.englishPrompt}, isolated decorative object, transparent background, no shadow, no background, no readable text, no logo, no label, no price tag, high quality PNG${styleSuffix}${avoidSuffix}`;
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
          const sectionHeightPx = elDef.section === 'header' ? headerHeightPx : footerHeightPx;
          const w = Math.round((elDef.suggestedSizePct / 100) * canvasWidthPx);
          const h = Math.round(w * 0.8); // default aspect ratio; user can resize

          let x = 0;
          let y = 0;
          switch (elDef.suggestedPosition) {
            case 'center':
              x = Math.round((canvasWidthPx - w) / 2);
              y = Math.round((sectionHeightPx - h) / 2);
              break;
            case 'right':
              x = canvasWidthPx - w;
              y = 0;
              break;
            case 'left':
              x = 0;
              y = 0;
              break;
            case 'bottom-left':
              x = 0;
              y = sectionHeightPx - h;
              break;
            case 'bottom-right':
              x = canvasWidthPx - w;
              y = sectionHeightPx - h;
              break;
            case 'top':
              x = 0;
              y = 0;
              w === canvasWidthPx ? null : (x = Math.round((canvasWidthPx - w) / 2));
              break;
            case 'bottom':
              x = 0;
              y = sectionHeightPx - h;
              break;
            default:
              x = Math.round((canvasWidthPx - w) / 2);
              y = Math.round((sectionHeightPx - h) / 2);
          }

          return {
            id: el.id,
            imageUrl: el.imageUrl,
            prompt: el.prompt,
            x,
            y,
            width: w,
            height: h,
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
      const parsed = await createStructuredChatCompletion({
        openai: this.openai,
        logger: this.logger,
        feature: context.feature,
        spec: { model: this.models.fastTextModel, ...IMAGE_INTENT_CALL },
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
        responseFormat: AI_RESPONSE_FORMATS.imageIntentClassification,
        parse: parseImageIntentClassification,
        emptyResponseMessage: 'Resposta vazia da classificação de intenção',
        retryAttempts: this.models.structuredResponseRetryAttempts,
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
}
