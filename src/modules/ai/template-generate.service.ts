import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { UploadsService } from '../uploads/uploads.service';
import { FormatDto, ChatMessageDto } from './dto/template-generate-request.dto';
import { TemplateGenerateResponseDto } from './dto/template-generate-response.dto';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import { uploadGeneratedAsset } from './utils/ai-image.util';
import { withAiLogging } from './utils/ai-telemetry.util';
import {
  LayoutNormalizationAdjustment,
  normalizeTemplateConfigurationLayout,
} from './utils/ai-layout.util';
import { OpenAiImageService } from './openai-image.service';
import { AI_RESPONSE_FORMATS, parseTemplateGenerateResponse } from './schemas/ai-response.schemas';
import { TEMPLATE_GENERATE_SYSTEM_PROMPT } from './prompts/template-generate.prompts';

interface StructuredChatCompletionOptions<T> {
  feature: string;
  model: string;
  request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
  parse: (raw: string) => T;
  emptyResponseMessage: string;
}

const GENERATE_PREFIX = 'GENERATE:';

@Injectable()
export class TemplateGenerateService {
  private readonly logger = new Logger(TemplateGenerateService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
    private readonly openAiImageService: OpenAiImageService,
  ) {
    this.models = getOpenAiModelConfig(configService);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — chamadas à IA irão falhar');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async generateTemplate(
    format: FormatDto,
    messages: ChatMessageDto[],
  ): Promise<TemplateGenerateResponseDto> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: TEMPLATE_GENERATE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Formato selecionado: ${format.type}\n- artWidthCm: ${format.artWidthCm}\n- artHeightCm: ${format.artHeightCm}\n- headerHeightCm: ${format.headerHeightCm}\n- footerHeightCm: ${format.footerHeightCm}\n\nCanvas width: ${(format.artWidthCm * 37.795).toFixed(0)}px | Header height: ${(format.headerHeightCm * 37.795).toFixed(0)}px | Footer height: ${(format.footerHeightCm * 37.795).toFixed(0)}px`,
      },
      { role: 'assistant', content: 'Entendido. Aguardo sua descrição do template.' },
    ];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        openaiMessages.push({ role: 'assistant', content: msg.content });
        continue;
      }

      if (msg.images && msg.images.length > 0) {
        const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
          { type: 'text', text: msg.content },
          ...msg.images.map(
            (dataUrl): OpenAI.Chat.ChatCompletionContentPart => ({
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'low' },
            }),
          ),
        ];
        openaiMessages.push({ role: 'user', content: contentParts });
      } else {
        openaiMessages.push({ role: 'user', content: msg.content });
      }
    }

    const result = await this.createStructuredChatCompletion({
      feature: 'template-generate.configuration',
      model: this.models.textModel,
      emptyResponseMessage: 'Resposta vazia do GPT-4o',
      parse: parseTemplateGenerateResponse,
      request: {
        model: this.models.textModel,
        response_format: AI_RESPONSE_FORMATS.templateConfiguration,
        max_tokens: 4000,
        messages: openaiMessages,
      },
    });
    let configuration = result.configuration;

    let imagesGenerated = false;
    await this.resolvePlaceholders(configuration, () => {
      imagesGenerated = true;
    });

    const normalizedConfiguration = normalizeTemplateConfigurationLayout(configuration, {
      canvasWidthPx: Math.round(format.artWidthCm * 37.795),
      headerHeightPx: Math.round(format.headerHeightCm * 37.795),
      footerHeightPx: Math.round(format.footerHeightCm * 37.795),
    });
    configuration = normalizedConfiguration.configuration;
    this.logLayoutNormalization(
      'template-generate.configuration-layout',
      normalizedConfiguration.adjustments,
    );

    this.validateConfiguration(configuration);

    return {
      assistantMessage: result.assistantMessage,
      configuration,
      imagesGenerated,
    };
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

  private async resolvePlaceholders(obj: unknown, onGenerated: () => void): Promise<void> {
    if (typeof obj === 'string') return;
    if (Array.isArray(obj)) {
      await Promise.all(obj.map((item) => this.resolvePlaceholders(item, onGenerated)));
      return;
    }
    if (typeof obj !== 'object' || obj === null) return;

    const record = obj as Record<string, unknown>;
    const promises: Promise<void>[] = [];

    for (const key of Object.keys(record)) {
      const value = record[key];

      if (typeof value === 'string' && value.startsWith(GENERATE_PREFIX)) {
        const prompt =
          value.slice(GENERATE_PREFIX.length).trim() || 'promotional supermarket background';
        promises.push(
          this.generateAndUploadImage(prompt)
            .then((url) => {
              record[key] = url;
              onGenerated();
            })
            .catch((err) => {
              this.logger.error(`Image generation failed for key "${key}": ${err?.message}`);
              record[key] = '';
            }),
        );
      } else {
        promises.push(this.resolvePlaceholders(value, onGenerated));
      }
    }

    await Promise.all(promises);
  }

  private async generateAndUploadImage(prompt: string): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const generated = await this.generatePlaceholderImage(prompt);
    const filename = `ai-${this.slugify(prompt.slice(0, 40))}-${Date.now()}.jpg`;

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
        feature: 'template-generate.placeholder-image',
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
        feature: 'template-generate.placeholder-image-fallback',
        prompt,
        size: '1024x1024',
        assetKind: 'legacy',
        mode: 'final',
        model: this.models.dalleFallbackModel,
        quality: 'standard',
      });
    }
  }

  private validateConfiguration(config: Record<string, unknown>): void {
    const requiredSectionFields = ['id', 'name', 'widthCm', 'heightCm', 'background', 'elements'];

    for (const section of ['header', 'footer'] as const) {
      const currentSection = config[section] as Record<string, unknown> | undefined;
      if (!currentSection || typeof currentSection !== 'object') {
        throw new Error(`Seção "${section}" ausente na configuration`);
      }

      for (const field of requiredSectionFields) {
        if (!(field in currentSection)) {
          throw new Error(`Campo obrigatório "${field}" ausente na seção "${section}"`);
        }
      }

      if (!Array.isArray(currentSection.elements)) {
        throw new Error(`"elements" deve ser um array na seção "${section}"`);
      }

      for (const element of currentSection.elements as unknown[]) {
        const typedElement = element as Record<string, unknown>;
        for (const field of ['id', 'type', 'x', 'y', 'width', 'height', 'zIndex']) {
          if (!(field in typedElement)) {
            throw new Error(`Elemento sem campo obrigatório "${field}" na seção "${section}"`);
          }
        }
      }
    }

    if (JSON.stringify(config).includes(GENERATE_PREFIX)) {
      throw new Error('Placeholders GENERATE: não resolvidos na configuration final');
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
