import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import { ImageUsage } from '../../shared/image/openai-image-capabilities';
import { withOpenAiRetry } from '../../shared/providers/openai-errors';
import { PaidResponseUnreadableError } from '../../shared/providers/openai-scene-call-errors';
import {
  assertSceneRequestAllowed,
  callSdkWithResponse,
  SceneCallOptions,
  SceneCallResponse,
  SceneRequestExtras,
} from './openai-image-scene-call';
import { buildMaskedEditBody, MaskedEditInput } from './openai-image-masked-edit';
import {
  MaterializedImage,
  OpenAiImageSize,
  materializeGeneratedImage,
} from './utils/ai-image.util';
import { withAiLogging } from './utils/ai-telemetry.util';

type ImageAssetKind = 'template' | 'background' | 'transparent' | 'legacy';
type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'standard' | 'auto';
type OpenAiImageBackground = 'transparent' | 'opaque' | 'auto';
type OpenAiImageOutputFormat = 'png' | 'jpeg' | 'webp';
type OpenAiImageInputFidelity = 'low' | 'high';
type OpenAiImageMode = 'final' | 'preview';

/** input_fidelity so existe em gpt-image-1.5 e gpt-image-1-mini; gpt-image-2*, 2.5* e chatgpt-image-latest nao o aceitam. */
export function supportsConfigurableInputFidelity(model: string): boolean {
  return model.startsWith('gpt-image-1.5') || model.startsWith('gpt-image-1-mini');
}

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
  /** Modo de chamada da cena (quota terminal, timeout próprio, usage e custo); ausente = comportamento de sempre. */
  sceneCall?: SceneCallOptions;
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
  sceneCall?: SceneCallOptions;
  /**
   * Edição local da cena: recorte e máscara PNG (alfa 255 = editar) do mesmo tamanho, enviados em
   * corpo JSON (`images` + `mask`, sem `markup`). Exige `sceneCall`; sem ela, o caminho multipart de sempre.
   */
  mask?: MaskedEditInput;
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
  /** Só no modo `sceneCall`. */
  usage?: ImageUsage;
  /** Só no modo `sceneCall`; `null` quando o modelo não tem preço conferido na tabela. */
  costUsd?: number | null;
  /** Só no modo `sceneCall`: `x-request-id` da OpenAI. */
  requestId?: string | null;
}

type ImageCallResponse = { data: { b64_json?: string; url?: string }[] } & Partial<
  Pick<SceneCallResponse, 'usage' | 'costUsd' | 'requestId'>
>;

/** Na cena a saída é PNG: `output_compression` só vale para jpeg/webp. Fora da cena, o valor segue como veio. */
function sceneOutputCompression(
  sceneCall: SceneCallOptions | undefined,
  outputFormat: OpenAiImageOutputFormat | undefined,
  compression: number | undefined,
): number | undefined {
  return sceneCall && outputFormat === 'png' ? undefined : compression;
}

/** `usage`, `costUsd` e `requestId` entram no resultado só no modo `sceneCall`. */
function sceneCallResult(
  sceneCall: SceneCallOptions | undefined,
  response: ImageCallResponse,
): Pick<OpenAiImageResult, 'usage' | 'costUsd' | 'requestId'> {
  if (!sceneCall) return {};
  return {
    usage: response.usage,
    costUsd: response.costUsd ?? null,
    requestId: response.requestId ?? null,
  };
}

/** `client.post` do SDK (a 6.x não tipa `mask` por JSON em `images.edit`). */
interface OpenAiJsonClient {
  post(path: string, options: object): { withResponse(): Promise<any> };
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
    const outputCompression = sceneOutputCompression(
      options.sceneCall,
      outputFormat,
      options.outputCompression ?? preset.outputCompression,
    );

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

    const response = await this.dispatchImageCall({
      method: 'generate',
      request,
      feature: options.feature,
      model,
      size: options.size,
      quality,
      mode,
      sceneCall: options.sceneCall,
      extras: { background },
    });

    const image = await this.materialize(response, preset.fallbackMimeType, options.sceneCall);

    return {
      image,
      model,
      size: options.size,
      quality,
      background,
      outputFormat,
      outputCompression,
      mode,
      ...sceneCallResult(options.sceneCall, response),
    };
  }

  async editImage(options: EditOpenAiImageOptions): Promise<OpenAiImageResult> {
    if (!this.openai) throw new Error('OpenAI não configurada');
    if (options.mask) return this.editImageWithMask(options);

    const assetKind = options.assetKind ?? 'template';
    // Public endpoints still default to final. Internal callers can opt into preview
    // with mode: 'preview' without changing request/response contracts.
    const mode = options.mode ?? this.models.imageDefaultMode;
    const model = options.model ?? this.resolveModel(mode, assetKind);
    const preset = this.resolvePreset(assetKind, mode);
    const quality = options.quality ?? preset.quality;
    const background = options.background ?? preset.background;
    const outputFormat = options.outputFormat ?? preset.outputFormat;
    const outputCompression = sceneOutputCompression(
      options.sceneCall,
      outputFormat,
      options.outputCompression ?? preset.outputCompression,
    );
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

    const response = await this.dispatchImageCall({
      method: 'edit',
      request,
      feature: options.feature,
      model,
      size: options.size,
      quality,
      mode,
      inputFidelity: supportsConfigurableInputFidelity(model) ? inputFidelity : undefined,
      sceneCall: options.sceneCall,
    });

    const image = await this.materialize(response, preset.fallbackMimeType, options.sceneCall);

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
      ...sceneCallResult(options.sceneCall, response),
    };
  }

  /**
   * Ramo separado da edição com máscara (M3 do spike): `POST /images/edits` em JSON pelo `client.post`,
   * porque o `images.edit` do SDK só envia multipart e o SDK instalado não tipa `mask` por JSON. Roda no
   * mesmo semáforo e retry do modo `sceneCall`; tamanho do recorte e da máscara conferidos antes da rede.
   */
  private async editImageWithMask(options: EditOpenAiImageOptions): Promise<OpenAiImageResult> {
    if (!options.sceneCall || !options.mask) {
      throw new Error('A edição com máscara só existe no modo sceneCall');
    }
    const { sceneCall } = options;
    const assetKind = options.assetKind ?? 'template';
    const mode = options.mode ?? this.models.imageDefaultMode;
    const model = options.model ?? this.resolveModel(mode, assetKind);
    const quality = options.quality ?? this.resolvePreset(assetKind, mode).quality;
    const outputFormat = options.outputFormat ?? 'png';
    const background = options.background ?? 'opaque';
    const input = options.images?.[0] ?? {
      buffer: options.imageBuffer,
      mimeType: options.imageMimeType ?? 'image/png',
      filename: 'crop.png',
    };
    const body = await buildMaskedEditBody({
      model,
      prompt: options.prompt,
      size: options.size,
      quality,
      background,
      outputFormat,
      image: input as OpenAiImageInput,
      mask: options.mask,
    });
    const client = this.openai as unknown as OpenAiJsonClient;
    const response = await this.dispatchImageCall({
      method: 'edit',
      request: body,
      feature: options.feature,
      model,
      size: options.size,
      quality,
      mode,
      sceneCall,
      extras: { mask: true, background },
      invoke: (req, sdkOptions) =>
        client.post('/images/edits', { body: req, ...(sdkOptions as object) }),
    });
    const image = await this.materialize(response, 'image/png', sceneCall);
    return {
      image,
      model,
      size: options.size,
      quality,
      background,
      outputFormat,
      mode,
      ...sceneCallResult(sceneCall, response),
    };
  }

  /** Lê a imagem da resposta; no modo `sceneCall` uma falha aqui já foi paga, então carrega o custo. */
  private async materialize(
    response: ImageCallResponse,
    fallbackMimeType: string,
    sceneCall?: SceneCallOptions,
  ): Promise<MaterializedImage> {
    try {
      return await materializeGeneratedImage(response.data[0], fallbackMimeType);
    } catch (error) {
      if (!sceneCall) throw error;
      throw new PaidResponseUnreadableError(
        (error as Error).message,
        response.costUsd ?? null,
        response.requestId ?? null,
      );
    }
  }

  /** Uma chamada ao SDK com log, semáforo e retry; no modo `sceneCall`, o caminho da cena. */
  private async dispatchImageCall(args: {
    method: 'generate' | 'edit';
    request: Record<string, unknown>;
    feature: string;
    model: string;
    size: string;
    quality: string;
    mode: string;
    inputFidelity?: string;
    sceneCall?: SceneCallOptions;
    /** Fundo transparente e máscara conferidos pela tabela de capacidades (só no modo `sceneCall`). */
    extras?: SceneRequestExtras;
    /** Chamada própria no lugar de `images[method]` (edição com máscara por JSON). */
    invoke?: (request: unknown, sdkOptions: unknown) => { withResponse(): Promise<any> };
  }): Promise<ImageCallResponse> {
    const { method, request, feature, model, sceneCall } = args;
    const endpoint = `images.${method}`;
    if (sceneCall) assertSceneRequestAllowed(model, args.size, args.quality, args.extras);
    // `images.generate`/`images.edit` precisam do `this` do cliente: chamar sempre pelo objeto.
    const images = this.openai!.images as any;

    return (await withAiLogging(
      this.logger,
      {
        feature,
        endpoint,
        model,
        size: args.size,
        quality: args.quality,
        mode: args.mode,
        inputFidelity: args.inputFidelity,
        correlationId: sceneCall?.correlationId,
      },
      () =>
        sceneCall
          ? this.runSceneOperation(() =>
              callSdkWithResponse(
                args.invoke ?? ((req, sdkOptions) => images[method](req, sdkOptions)),
                request,
                model,
                sceneCall,
              ),
            )
          : this.runImageOperation(() => images[method](request), { feature, endpoint, model }),
    )) as ImageCallResponse;
  }

  /** Cena: semáforo + `withOpenAiRetry` (quota terminal na 1ª resposta; 5xx/429 de taxa/rede re-tentam). */
  private runSceneOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.withImageConcurrency(() =>
      withOpenAiRetry(operation, {
        attempts: this.imageRetryAttempts + 1,
        baseDelayMs: this.imageRetryBaseDelayMs,
      }),
    );
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
    if (options.inputFidelity && supportsConfigurableInputFidelity(options.model)) {
      request.input_fidelity = options.inputFidelity;
    }

    return request;
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
