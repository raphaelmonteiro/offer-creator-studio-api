import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { UploadsService } from '../uploads/uploads.service';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import { FormatDto, ChatMessageDto } from './dto/template-generate-request.dto';
import { TemplateElementResponseDto } from './dto/template-element-request.dto';
import { OpenAiImageService } from './openai-image.service';
import { TEMPLATE_ELEMENT_SYSTEM_PROMPT } from './prompts/template-element.prompts';
import { AI_RESPONSE_FORMATS, parseTemplateElementResponse } from './schemas/ai-response.schemas';
import { uploadGeneratedAsset } from './utils/ai-image.util';
import { withAiLogging } from './utils/ai-telemetry.util';
import {
  LayoutNormalizationAdjustment,
  normalizeCanvasBackgroundRecord,
  normalizeCanvasElementRecord,
} from './utils/ai-layout.util';

const GENERATE_PREFIX = 'GENERATE:';

interface StructuredChatCompletionOptions<T> {
  feature: string;
  model: string;
  request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  parse: (raw: string) => T;
  emptyResponseMessage: string;
}

@Injectable()
export class TemplateElementAssistantService {
  private readonly logger = new Logger(TemplateElementAssistantService.name);
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

  async generateTemplateElement(
    format: FormatDto,
    activeSection: 'header' | 'footer' | 'body',
    messages: ChatMessageDto[],
    templateContext?: Record<string, unknown>,
  ): Promise<TemplateElementResponseDto> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const canvasWidthPx = Math.round(format.artWidthCm * 37.795);
    const headerHeightPx = Math.round(format.headerHeightCm * 37.795);
    const footerHeightPx = Math.round(format.footerHeightCm * 37.795);
    const canvasW = canvasWidthPx.toFixed(0);
    const headerH = headerHeightPx.toFixed(0);
    const footerH = footerHeightPx.toFixed(0);

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: TEMPLATE_ELEMENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Format: ${format.type}, ${format.artWidthCm}×${format.artHeightCm}cm\n` +
          `Canvas: ${canvasW}px wide | Header: ${headerH}px tall | Footer: ${footerH}px tall\n` +
          `Active section: ${activeSection}`,
      },
      { role: 'assistant', content: 'Entendido. Aguardo sua instrução.' },
    ];

    if (templateContext) {
      openaiMessages.push({
        role: 'user',
        content: `[TEMPLATE CONTEXT]\n${JSON.stringify(templateContext, null, 2)}`,
      });
      openaiMessages.push({
        role: 'assistant',
        content: 'Template context loaded. I will use it for positioning and updates.',
      });
    }

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        openaiMessages.push({ role: 'assistant', content: msg.content });
        continue;
      }

      if (msg.images && msg.images.length > 0) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
          { type: 'text', text: msg.content },
          ...msg.images.map(
            (dataUrl): OpenAI.Chat.ChatCompletionContentPart => ({
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'low' },
            }),
          ),
        ];
        openaiMessages.push({ role: 'user', content: parts });
      } else {
        openaiMessages.push({ role: 'user', content: msg.content });
      }
    }

    const { assistantMessage, actions } = await this.createStructuredChatCompletion({
      feature: 'template-element.actions',
      model: this.models.textModel,
      emptyResponseMessage: 'Resposta vazia do GPT-4o',
      parse: parseTemplateElementResponse,
      request: {
        model: this.models.textModel,
        response_format: AI_RESPONSE_FORMATS.templateElementActions,
        max_tokens: 2000,
        messages: openaiMessages,
      },
    });

    const layoutAdjustments: LayoutNormalizationAdjustment[] = [];
    for (const action of actions) {
      if (action.element) {
        if (action.section === 'body') {
          const fallbackSection = activeSection === 'footer' ? 'footer' : 'header';
          layoutAdjustments.push({
            target: 'element',
            section: fallbackSection,
            elementId: typeof action.element.id === 'string' ? action.element.id : action.elementId,
            field: 'section',
            from: action.section,
            to: fallbackSection,
            reason: 'body-does-not-accept-elements',
          });
          action.section = fallbackSection;
        }

        await this.resolveElementPlaceholders(action.element);
        const normalized = normalizeCanvasElementRecord(
          action.element,
          { canvasWidthPx, headerHeightPx, footerHeightPx },
          action.section,
          5,
        );
        action.element = normalized.element;
        layoutAdjustments.push(...normalized.adjustments);
      }

      if (action.updates) {
        await this.resolveElementPlaceholders(action.updates);
      }

      if (action.background) {
        await this.resolveElementPlaceholders(action.background);
        const normalized = normalizeCanvasBackgroundRecord(action.background, action.section);
        action.background = normalized.background;
        layoutAdjustments.push(...normalized.adjustments);
      }
    }

    this.logLayoutNormalization('template-element.actions', layoutAdjustments);

    return { assistantMessage, actions };
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

  private async resolveElementPlaceholders(
    obj: Record<string, unknown>,
    transparent = false,
  ): Promise<void> {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith(GENERATE_PREFIX)) {
        const prompt = val.slice(GENERATE_PREFIX.length).trim();
        try {
          const useTransparent = transparent || key === 'src';
          const url = useTransparent
            ? await this.generateTransparentImage(prompt)
            : await this.generateAndUploadImage(prompt);
          obj[key] = url;
        } catch (err) {
          this.logger.error(`Image generation failed for "${key}": ${(err as Error).message}`);
          obj[key] = '';
        }
      }
    }
  }

  private async generateTransparentImage(prompt: string): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const generated = await this.openAiImageService.generateImage({
      feature: 'template-element.transparent-image',
      prompt: `${prompt}. Isolated object on a completely transparent background, PNG format, no shadows on ground, no floor, no scene.`,
      size: '1024x1024',
      assetKind: 'transparent',
      mode: 'final',
    });
    const slug = this.slugify(prompt.slice(0, 40));
    const filename = `ai-element-${slug}-${Date.now()}.png`;

    const result = await uploadGeneratedAsset({
      buffer: generated.image.buffer,
      filename,
      mimeType: 'image/png',
      folder: 'templates',
      uploadsService: this.uploadsService,
    });
    return result.url;
  }

  private async generateAndUploadImage(prompt: string): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const generated = await this.generatePlaceholderImage(prompt);
    const slug = this.slugify(prompt.slice(0, 40));
    const filename = `ai-${slug}-${Date.now()}.jpg`;

    const result = await uploadGeneratedAsset({
      buffer: generated.image.buffer,
      filename,
      mimeType: 'image/jpeg',
      folder: 'templates',
      uploadsService: this.uploadsService,
    });
    return result.url;
  }

  private async generatePlaceholderImage(prompt: string) {
    try {
      return await this.openAiImageService.generateImage({
        feature: 'template-element.placeholder-image',
        prompt,
        size: '1024x1024',
        assetKind: 'template',
        mode: 'final',
        model: this.models.imageModel,
        outputFormat: 'jpeg',
        outputCompression: 85,
        background: 'opaque',
      });
    } catch (error) {
      if (!this.models.enableDalleFallback) {
        throw error;
      }

      this.logger.warn(
        `GPT Image placeholder generation failed; trying DALL-E fallback: ${(error as Error).message}`,
      );

      return this.openAiImageService.generateImage({
        feature: 'template-element.placeholder-image-fallback',
        prompt,
        size: '1024x1024',
        assetKind: 'legacy',
        mode: 'final',
        model: this.models.dalleFallbackModel,
        quality: 'standard',
      });
    }
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
