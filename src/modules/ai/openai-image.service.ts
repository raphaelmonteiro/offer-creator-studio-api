import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import {
  MaterializedImage,
  OpenAiImageSize,
  materializeGeneratedImage,
} from './utils/ai-image.util';
import { withAiLogging } from './utils/ai-telemetry.util';

type ImageAssetKind = 'template' | 'background' | 'transparent' | 'legacy';
type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'standard' | 'auto';
type OpenAiImageBackground = 'transparent' | 'opaque' | 'auto';
type OpenAiImageOutputFormat = 'png' | 'jpeg' | 'webp';
type OpenAiImageInputFidelity = 'low' | 'high';
type OpenAiImageMode = 'final' | 'preview';

interface ImagePreset {
  quality: OpenAiImageQuality;
  background?: OpenAiImageBackground;
  outputFormat?: OpenAiImageOutputFormat;
  outputCompression?: number;
  fallbackMimeType: string;
}

export interface GenerateOpenAiImageOptions {
  feature: string;
  prompt: string;
  size: OpenAiImageSize;
  assetKind: ImageAssetKind;
  mode?: OpenAiImageMode;
  model?: string;
  quality?: OpenAiImageQuality;
  background?: OpenAiImageBackground;
  outputFormat?: OpenAiImageOutputFormat;
  outputCompression?: number;
}

export interface OpenAiImageInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface EditOpenAiImageOptions {
  feature: string;
  prompt: string;
  imageBuffer?: Buffer;
  imageMimeType?: string;
  images?: OpenAiImageInput[];
  size: OpenAiImageSize;
  assetKind?: ImageAssetKind;
  mode?: OpenAiImageMode;
  model?: string;
  quality?: OpenAiImageQuality;
  background?: OpenAiImageBackground;
  outputFormat?: OpenAiImageOutputFormat;
  outputCompression?: number;
  inputFidelity?: OpenAiImageInputFidelity;
}

export interface OpenAiImageResult {
  image: MaterializedImage;
  model: string;
  size: OpenAiImageSize;
  quality: OpenAiImageQuality;
  background?: OpenAiImageBackground;
  outputFormat?: OpenAiImageOutputFormat;
  outputCompression?: number;
  inputFidelity?: OpenAiImageInputFidelity;
  mode: OpenAiImageMode;
}

interface RetryContext {
  feature: string;
  endpoint: string;
  model: string;
}

@Injectable()
export class OpenAiImageService {
  private readonly logger = new Logger(OpenAiImageService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;
  private readonly imageConcurrencyLimit: number;
  private readonly imageRetryAttempts: number;
  private readonly imageRetryBaseDelayMs: number;
  private readonly imageRetryMaxDelayMs: number;
  private activeImageOperations = 0;
  private readonly imageQueue: Array<() => void> = [];

  constructor(private readonly configService: ConfigService) {
    this.models = getOpenAiModelConfig(configService);
    this.imageConcurrencyLimit = this.getPositiveIntegerEnv('OPENAI_IMAGE_CONCURRENCY_LIMIT', 2);
    this.imageRetryAttempts = this.getPositiveIntegerEnv('OPENAI_IMAGE_RETRY_ATTEMPTS', 2);
    this.imageRetryBaseDelayMs = this.getPositiveIntegerEnv(
      'OPENAI_IMAGE_RETRY_BASE_DELAY_MS',
      750,
    );
    this.imageRetryMaxDelayMs = this.getPositiveIntegerEnv('OPENAI_IMAGE_RETRY_MAX_DELAY_MS', 5000);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async generateImage(options: GenerateOpenAiImageOptions): Promise<OpenAiImageResult> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    // Public endpoints still default to final. Internal callers can opt into preview
    // with mode: 'preview' without changing request/response contracts.
    const mode = options.mode ?? this.models.imageDefaultMode;
    const model = options.model ?? this.resolveModel(mode, options.assetKind);
    const preset = this.resolvePreset(options.assetKind, mode);
    const quality = options.quality ?? preset.quality;
    const background = options.background ?? preset.background;
    const outputFormat = options.outputFormat ?? preset.outputFormat;
    const outputCompression = options.outputCompression ?? preset.outputCompression;

    const request = this.buildGenerateRequest({
      model,
      prompt: options.prompt,
      size: options.size,
      quality,
      background,
      outputFormat,
      outputCompression,
      legacy: options.assetKind === 'legacy',
    });

    const response = (await withAiLogging(
      this.logger,
      {
        feature: options.feature,
        endpoint: 'images.generate',
        model,
        size: options.size,
        quality,
        mode,
      },
      () =>
        this.runImageOperation(() => (this.openai!.images.generate as any)(request), {
          feature: options.feature,
          endpoint: 'images.generate',
          model,
        }),
    )) as { data: { b64_json?: string; url?: string }[] };

    const image = await materializeGeneratedImage(response.data[0], preset.fallbackMimeType);

    return {
      image,
      model,
      size: options.size,
      quality,
      background,
      outputFormat,
      outputCompression,
      mode,
    };
  }

  async editImage(options: EditOpenAiImageOptions): Promise<OpenAiImageResult> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const assetKind = options.assetKind ?? 'template';
    // Public endpoints still default to final. Internal callers can opt into preview
    // with mode: 'preview' without changing request/response contracts.
    const mode = options.mode ?? this.models.imageDefaultMode;
    const model = options.model ?? this.resolveModel(mode, assetKind);
    const preset = this.resolvePreset(assetKind, mode);
    const quality = options.quality ?? preset.quality;
    const background = options.background ?? preset.background;
    const outputFormat = options.outputFormat ?? preset.outputFormat;
    const outputCompression = options.outputCompression ?? preset.outputCompression;
    const inputFidelity = options.inputFidelity ?? this.models.imageInputFidelity;
    const imageFiles = await this.buildImageFiles(options);

    const request = this.buildEditRequest({
      model,
      image: imageFiles.length === 1 ? imageFiles[0] : imageFiles,
      prompt: options.prompt,
      size: options.size,
      quality,
      background,
      outputFormat,
      outputCompression,
      inputFidelity,
    });

    const response = (await withAiLogging(
      this.logger,
      {
        feature: options.feature,
        endpoint: 'images.edit',
        model,
        size: options.size,
        quality,
        mode,
        inputFidelity: this.supportsConfigurableInputFidelity(model) ? inputFidelity : undefined,
      },
      () =>
        this.runImageOperation(() => (this.openai!.images.edit as any)(request), {
          feature: options.feature,
          endpoint: 'images.edit',
          model,
        }),
    )) as { data: { b64_json?: string; url?: string }[] };

    const image = await materializeGeneratedImage(response.data[0], preset.fallbackMimeType);

    return {
      image,
      model,
      size: options.size,
      quality,
      background,
      outputFormat,
      outputCompression,
      inputFidelity,
      mode,
    };
  }

  private async buildImageFiles(options: EditOpenAiImageOptions): Promise<unknown[]> {
    const imageInputs = options.images?.length
      ? options.images
      : options.imageBuffer
        ? [
            {
              buffer: options.imageBuffer,
              mimeType: options.imageMimeType ?? 'image/png',
              filename: 'template.png',
            },
          ]
        : [];

    if (!imageInputs.length) {
      throw new Error('Nenhuma imagem informada para edição');
    }

    return Promise.all(
      imageInputs.map((image, index) =>
        toFile(image.buffer, image.filename || `image-${index + 1}.png`, {
          type: image.mimeType,
        }),
      ),
    );
  }

  private resolvePreset(assetKind: ImageAssetKind, mode: OpenAiImageMode): ImagePreset {
    const defaultQuality = this.configService.get<OpenAiImageQuality>(
      'OPENAI_IMAGE_QUALITY',
      'high',
    );
    const previewQuality = this.models.imagePreviewQuality;
    const defaultOutputFormat = this.configService.get<OpenAiImageOutputFormat>(
      'OPENAI_IMAGE_OUTPUT_FORMAT',
      'jpeg',
    );
    const defaultCompression = parseInt(
      this.configService.get<string>('OPENAI_IMAGE_OUTPUT_COMPRESSION', '85'),
      10,
    );

    if (assetKind === 'transparent') {
      return {
        quality: mode === 'preview' ? previewQuality : defaultQuality,
        background: 'transparent',
        outputFormat: 'png',
        fallbackMimeType: 'image/png',
      };
    }

    if (assetKind === 'legacy') {
      return {
        quality: 'standard',
        fallbackMimeType: 'image/jpeg',
      };
    }

    return {
      quality: mode === 'preview' ? previewQuality : defaultQuality,
      background: this.configService.get<OpenAiImageBackground>(
        'OPENAI_IMAGE_BACKGROUND',
        'opaque',
      ),
      outputFormat: defaultOutputFormat,
      outputCompression:
        defaultOutputFormat === 'jpeg' || defaultOutputFormat === 'webp'
          ? defaultCompression
          : undefined,
      fallbackMimeType: `image/${defaultOutputFormat}`,
    };
  }

  private resolveModel(mode: OpenAiImageMode, assetKind: ImageAssetKind): string {
    if (assetKind === 'legacy') {
      return this.models.dalleFallbackModel;
    }

    return mode === 'preview' ? this.models.imagePreviewModel : this.models.imageModel;
  }

  private buildGenerateRequest(options: {
    model: string;
    prompt: string;
    size: OpenAiImageSize;
    quality: OpenAiImageQuality;
    background?: OpenAiImageBackground;
    outputFormat?: OpenAiImageOutputFormat;
    outputCompression?: number;
    legacy: boolean;
  }) {
    const request: Record<string, unknown> = {
      model: options.model,
      prompt: options.prompt,
      size: options.size,
      quality: options.quality,
      n: 1,
    };

    if (!options.legacy) {
      if (options.background) request.background = options.background;
      if (options.outputFormat) request.output_format = options.outputFormat;
      if (options.outputCompression !== undefined)
        request.output_compression = options.outputCompression;
    }

    return request;
  }

  private buildEditRequest(options: {
    model: string;
    image: unknown;
    prompt: string;
    size: OpenAiImageSize;
    quality: OpenAiImageQuality;
    background?: OpenAiImageBackground;
    outputFormat?: OpenAiImageOutputFormat;
    outputCompression?: number;
    inputFidelity?: OpenAiImageInputFidelity;
  }) {
    const request: Record<string, unknown> = {
      model: options.model,
      image: options.image,
      prompt: options.prompt,
      size: options.size,
      quality: options.quality,
      n: 1,
    };

    if (options.background) request.background = options.background;
    if (options.outputFormat) request.output_format = options.outputFormat;
    if (options.outputCompression !== undefined)
      request.output_compression = options.outputCompression;
    if (options.inputFidelity && this.supportsConfigurableInputFidelity(options.model)) {
      request.input_fidelity = options.inputFidelity;
    }

    return request;
  }

  private supportsConfigurableInputFidelity(model: string): boolean {
    return model !== 'gpt-image-2';
  }

  private async runImageOperation<T>(
    operation: () => Promise<T>,
    context: RetryContext,
  ): Promise<T> {
    return this.withImageConcurrency(() => this.withRetry(operation, context));
  }

  private async withImageConcurrency<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireImageSlot();
    try {
      return await operation();
    } finally {
      this.releaseImageSlot();
    }
  }

  private async acquireImageSlot(): Promise<void> {
    if (this.activeImageOperations < this.imageConcurrencyLimit) {
      this.activeImageOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.imageQueue.push(resolve);
    });
    this.activeImageOperations += 1;
  }

  private releaseImageSlot(): void {
    this.activeImageOperations = Math.max(0, this.activeImageOperations - 1);
    const next = this.imageQueue.shift();
    if (next) {
      next();
    }
  }

  private async withRetry<T>(operation: () => Promise<T>, context: RetryContext): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.imageRetryAttempts) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= this.imageRetryAttempts || !this.isRetryableOpenAiError(error)) {
          throw error;
        }

        const delayMs = this.calculateRetryDelay(attempt);
        this.logger.warn(
          `AI operation retry ${JSON.stringify({
            feature: context.feature,
            endpoint: context.endpoint,
            model: context.model,
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            maxAttempts: this.imageRetryAttempts + 1,
            delayMs,
            reason: this.getRetryReason(error),
          })}`,
        );

        await this.sleep(delayMs);
        attempt += 1;
      }
    }

    throw lastError;
  }

  private isRetryableOpenAiError(error: unknown): boolean {
    const status = this.getErrorStatus(error);
    if (status !== undefined) {
      return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    }

    const code = this.getErrorCode(error);
    if (!code) {
      return false;
    }

    return [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'APIConnectionTimeoutError',
      'APIConnectionError',
    ].includes(code);
  }

  private calculateRetryDelay(attempt: number): number {
    const exponentialDelay = this.imageRetryBaseDelayMs * 2 ** attempt;
    return Math.min(exponentialDelay, this.imageRetryMaxDelayMs);
  }

  private getRetryReason(error: unknown): string {
    const status = this.getErrorStatus(error);
    if (status !== undefined) {
      return `status_${status}`;
    }

    return this.getErrorCode(error) ?? 'transient_error';
  }

  private getErrorStatus(error: unknown): number | undefined {
    const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status;
    if (typeof status === 'number') return status;

    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }

  private getErrorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown; name?: unknown } | null)?.code;
    if (typeof code === 'string') return code;

    const name = (error as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : undefined;
  }

  private sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private getPositiveIntegerEnv(key: string, defaultValue: number): number {
    const value = Number(this.configService.get<string>(key, `${defaultValue}`));
    if (!Number.isFinite(value) || value < 1) {
      return defaultValue;
    }

    return Math.floor(value);
  }
}
