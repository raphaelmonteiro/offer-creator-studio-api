import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  MaterializedImage,
  materializeGeneratedImage,
  selectImageSizeByAspectRatio,
  uploadGeneratedAsset,
} from './utils/ai-image.util';
import { fetchWithTimeout } from './utils/fetch-with-timeout.util';
import { withAiLogging } from './utils/ai-telemetry.util';
import { UploadsService } from '../uploads/uploads.service';
import { OpenAiImageInput, OpenAiImageService } from './openai-image.service';
import {
  AI_RESPONSE_FORMATS,
  ImageIntentCategory,
  parseImageIntentClassification,
} from './schemas/ai-response.schemas';
import { IMAGE_INTENT_CLASSIFICATION_SYSTEM_PROMPT } from './prompts/image-intent.prompts';
import {
  TEMPLATE_IMAGE_REFERENCE_VISION_PROMPT,
  TEMPLATE_IMAGE_REPLY_SYSTEM_PROMPT,
  buildTemplateImageTranslationSystemPrompt,
} from './prompts/template-image.prompts';

interface TemplateImageFormat {
  type: string;
  printWidthCm: number;
  printHeightCm: number;
}

interface TemplateImageMessage {
  role: 'user' | 'assistant';
  content: string;
  imageUrl?: string;
  images?: string[];
}

interface TemplateImageResponse {
  imageUrl: string;
  assistantMessage: string;
  promptUsed: string;
}

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
export class TemplateImageGeneratorService {
  private readonly logger = new Logger(TemplateImageGeneratorService.name);
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

  async generateTemplateImage(
    format: TemplateImageFormat,
    messages: TemplateImageMessage[],
  ): Promise<TemplateImageResponse> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) throw new Error('Nenhuma mensagem do usuário encontrada');

    // Find the last assistant message that has an imageUrl (for iterative editing)
    const lastAssistantWithImage = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.imageUrl);

    // Reference images attached by the user in the last message
    const userReferenceImages = lastUserMessage.images ?? [];
    const isRefinement = !!lastAssistantWithImage;
    const imageIntent = await this.classifyImageIntent({
      feature: 'template-image.intent',
      userMessage: lastUserMessage.content,
      hasExistingImage: isRefinement,
      hasReferenceImages: userReferenceImages.length > 0,
    });

    if (imageIntent.shouldPreserveExistingImage && lastAssistantWithImage?.imageUrl) {
      return {
        imageUrl: lastAssistantWithImage.imageUrl,
        assistantMessage: this.getPreservedImageMessage(imageIntent),
        promptUsed: lastUserMessage.content,
      };
    }

    // ── Step 1: Vision analysis of reference images ──────────────────────────
    // When reference images are provided, use GPT-4o Vision to extract a
    // precise technical description BEFORE crafting the generation prompt.
    // This is far more reliable than passing the images as vague "context".
    let referenceStyleDescription = '';
    if (userReferenceImages.length > 0) {
      type VisionPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

      const visionContent: VisionPart[] = [
        {
          type: 'text',
          text: TEMPLATE_IMAGE_REFERENCE_VISION_PROMPT,
        },
        ...userReferenceImages.slice(0, 3).map((img) => ({
          type: 'image_url' as const,
          image_url: { url: img, detail: 'high' as const },
        })),
      ];

      const visionResponse = (await withAiLogging(
        this.logger,
        {
          feature: 'template-image.reference-vision',
          endpoint: 'chat.completions',
          model: this.models.textModel,
        },
        () =>
          this.openai!.chat.completions.create({
            model: this.models.textModel,
            max_tokens: 700,
            temperature: 0.1,
            messages: [{ role: 'user', content: visionContent }],
          } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
      )) as OpenAI.Chat.ChatCompletion;

      referenceStyleDescription = visionResponse.choices[0]?.message?.content?.trim() ?? '';
      this.logger.log(`Reference analysis extracted (${referenceStyleDescription.length} chars)`);
    }

    // ── Step 2: Translate + enrich the user's PT message into an EN prompt ───
    // When reference images were analyzed, inject the analysis directly into
    // the system prompt so the output prompt is grounded in exact visual facts.
    // When reference images are present, send them directly to the Image API edit
    // endpoint and keep GPT-4o Vision analysis only as prompt context.
    const useEditEndpoint =
      imageIntent.shouldEditExistingImage && isRefinement && userReferenceImages.length === 0;

    // Physical dimensions context — the user's message may reference percentages
    const W = format.printWidthCm;
    const H = format.printHeightCm;
    const dimensionsCtx = `The template is ${W}×${H} cm (width×height).`;

    const translationSystemPrompt = buildTemplateImageTranslationSystemPrompt({
      dimensionsContext: dimensionsCtx,
      templateHeightCm: H,
      useEditEndpoint,
      referenceStyleDescription,
    });

    const translationResponse = (await withAiLogging(
      this.logger,
      {
        feature: 'template-image.prompt',
        endpoint: 'chat.completions',
        model: this.models.textModel,
      },
      () =>
        this.openai!.chat.completions.create({
          model: this.models.textModel,
          max_tokens: 500,
          temperature: 0.2,
          messages: [
            { role: 'system', content: translationSystemPrompt },
            { role: 'user', content: lastUserMessage.content },
          ],
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
    )) as OpenAI.Chat.ChatCompletion;

    const enrichedPrompt = translationResponse.choices[0]?.message?.content?.trim();
    if (!enrichedPrompt) throw new Error('Falha ao traduzir prompt');

    this.logger.log(
      `Image prompt prepared ${JSON.stringify({
        feature: 'template-image',
        promptLength: enrichedPrompt.length,
      })}`,
    );

    // ── Step 3: pick the closest supported size to the format's aspect ratio ─
    const size = selectImageSizeByAspectRatio(format.printWidthCm, format.printHeightCm);
    const referenceImageInputs = await this.materializeReferenceImageInputs(
      userReferenceImages,
      'template-image',
    );

    // ── Step 4: generate or edit the image ─────────────────────────────────
    // Use images.edit for targeted refinements and reference-guided generation.
    // Use images.generate only when there are no image inputs.
    let generatedImage: MaterializedImage;

    if (useEditEndpoint && lastAssistantWithImage!.imageUrl) {
      // Small targeted edit — download existing image and edit it
      const existingImageResponse = await fetchWithTimeout(lastAssistantWithImage!.imageUrl);
      if (!existingImageResponse.ok) {
        throw new Error('Falha ao baixar imagem anterior para edição');
      }
      const existingBuffer = Buffer.from(await existingImageResponse.arrayBuffer());

      const generated = await this.openAiImageService.editImage({
        feature: 'template-image.edit',
        prompt: enrichedPrompt,
        imageBuffer: existingBuffer,
        imageMimeType: existingImageResponse.headers.get('content-type') || 'image/png',
        size,
        assetKind: 'template',
        mode: 'final',
        inputFidelity: this.models.imageInputFidelity,
      });
      generatedImage = generated.image;
    } else if (referenceImageInputs.length > 0) {
      const editInputs = [...referenceImageInputs];

      if (lastAssistantWithImage?.imageUrl) {
        const existingImageResponse = await fetchWithTimeout(lastAssistantWithImage.imageUrl);
        if (!existingImageResponse.ok) {
          throw new Error('Falha ao baixar imagem anterior para edição');
        }
        editInputs.unshift({
          buffer: Buffer.from(await existingImageResponse.arrayBuffer()),
          mimeType: existingImageResponse.headers.get('content-type') || 'image/png',
          filename: 'previous-template.png',
        });
      }

      const generated = await this.openAiImageService.editImage({
        feature: 'template-image.reference-generate',
        prompt: enrichedPrompt,
        images: editInputs,
        size,
        assetKind: 'template',
        mode: 'final',
        inputFidelity: this.models.imageInputFidelity,
      });
      generatedImage = generated.image;
    } else {
      const generated = await this.openAiImageService.generateImage({
        feature: 'template-image.generate',
        prompt: enrichedPrompt,
        size,
        assetKind: 'template',
        mode: 'final',
      });
      generatedImage = generated.image;
    }

    // Step 4: upload to our bucket
    const ext = generatedImage.extension;
    const slug = this.slugify(format.type);
    const filename = `ai-template-${slug}-${Date.now()}${ext}`;

    const uploaded = await uploadGeneratedAsset({
      buffer: generatedImage.buffer,
      filename,
      mimeType: generatedImage.mimeType,
      folder: 'templates',
      uploadsService: this.uploadsService,
    });

    // Step 5: generate a friendly PT response message
    const replyResponse = await withAiLogging(
      this.logger,
      {
        feature: 'template-image.reply',
        endpoint: 'chat.completions',
        model: this.models.textModel,
      },
      () =>
        this.openai!.chat.completions.create({
          model: this.models.textModel,
          max_tokens: 150,
          temperature: 0.7,
          messages: [
            {
              role: 'system',
              content: TEMPLATE_IMAGE_REPLY_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: isRefinement
                ? `O usuário pediu: "${lastUserMessage.content}". A imagem foi editada conforme solicitado.`
                : `O usuário pediu: "${lastUserMessage.content}". Um template foi gerado com o tema solicitado.`,
            },
          ],
        }),
    );

    const assistantMessage =
      replyResponse.choices[0]?.message?.content?.trim() ||
      (isRefinement ? 'Imagem atualizada conforme solicitado!' : 'Template gerado com sucesso!');

    return {
      imageUrl: uploaded.url,
      assistantMessage,
      promptUsed: enrichedPrompt,
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

  private getPreservedImageMessage(intent: ImageIntentClassification): string {
    if (intent.category === 'text_change') {
      return 'A imagem foi preservada porque o pedido parece ser uma alteração de texto editável.';
    }
    if (intent.category === 'layout_change') {
      return 'A imagem foi preservada porque o pedido parece ser uma alteração de layout.';
    }
    return 'A imagem atual foi preservada.';
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
