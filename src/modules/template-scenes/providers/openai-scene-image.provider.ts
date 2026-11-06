import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiImageService } from '../../ai/openai-image.service';
import {
  PaidResponseUnreadableError,
  SCENE_INVALID_REQUEST_CODE,
  SCENE_TIMEOUT_CODE,
} from '../../../shared/providers/openai-scene-call-errors';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import {
  SceneEditInput,
  SceneGenerateInput,
  SceneGenerateResult,
  SceneImageProvider,
  SceneProviderError,
} from './scene-image-provider';

const DEFAULT_TIMEOUT_MS = 180_000;
const CONTENT_POLICY_CODES = ['content_policy_violation', 'moderation_blocked'];

type ImageQuality = Parameters<OpenAiImageService['generateImage']>[0]['quality'];
type ImageSize = Parameters<OpenAiImageService['generateImage']>[0]['size'];

/** Classifica o erro do serviço de imagem no código que a versão grava. Nunca inclui chave. */
export function classifySceneProviderError(error: unknown): SceneProviderError {
  if (error instanceof SceneProviderError) return error;
  if (error instanceof PaidResponseUnreadableError) {
    return new SceneProviderError('PROVIDER_ERROR', error.message, error.costUsd);
  }
  if (error instanceof TerminalProviderError) {
    if (error.code === 'quota') return new SceneProviderError('PROVIDER_QUOTA', error.message);
    if (error.code === SCENE_TIMEOUT_CODE) {
      return new SceneProviderError('PROVIDER_TIMEOUT', error.message);
    }
    if (error.code === SCENE_INVALID_REQUEST_CODE) {
      return new SceneProviderError('PROVIDER_ERROR', error.message);
    }
  }
  const shape = (error ?? {}) as { status?: number; code?: string; error?: { code?: string } };
  const code = shape.code ?? shape.error?.code ?? '';
  if (shape.status === 400 && CONTENT_POLICY_CODES.includes(code)) {
    return new SceneProviderError(
      'PROVIDER_CONTENT_POLICY',
      'Pedido recusado pela política de conteúdo',
    );
  }
  const message =
    error instanceof Error ? error.message : 'Falha desconhecida do provedor de imagem';
  return new SceneProviderError('PROVIDER_ERROR', message);
}

/** Provedor real: `OpenAiImageService` no modo `sceneCall` (quota terminal, timeout, usage e custo). */
@Injectable()
export class OpenAiSceneImageProvider implements SceneImageProvider {
  readonly name = 'openai' as const;

  constructor(
    private readonly images: OpenAiImageService,
    private readonly config: ConfigService,
  ) {}

  async generate(input: SceneGenerateInput): Promise<SceneGenerateResult> {
    return this.run(() =>
      this.images.generateImage({
        feature: 'template-scene',
        prompt: input.prompt,
        size: input.size as ImageSize,
        assetKind: 'template',
        model: input.model,
        quality: input.quality as ImageQuality,
        outputFormat: 'png',
        sceneCall: this.sceneCall(input),
      }),
    );
  }

  /** Edição da imagem inteira, com `markup` (multipart) quando o cliente marcou; sempre PNG opaco. */
  async edit(input: SceneEditInput): Promise<SceneGenerateResult> {
    return this.run(() =>
      this.images.editImage({
        feature: 'template-scene',
        prompt: input.prompt,
        imageBuffer: input.image,
        imageMimeType: 'image/png',
        size: input.size as ImageSize,
        assetKind: 'template',
        model: input.model,
        quality: input.quality as ImageQuality,
        outputFormat: 'png',
        background: 'opaque',
        sceneCall: this.sceneCall(input),
        ...(input.mask ? { mask: { buffer: input.mask } } : {}),
        ...(input.markup ? { markup: { buffer: input.markup } } : {}),
      }),
    );
  }

  /** PNG com fundo transparente (o "adicionar"); o modelo precisa estar marcado na tabela de capacidades. */
  async generateTransparent(input: SceneGenerateInput): Promise<SceneGenerateResult> {
    return this.run(() =>
      this.images.generateImage({
        feature: 'template-scene',
        prompt: input.prompt,
        size: input.size as ImageSize,
        assetKind: 'transparent',
        model: input.model,
        quality: input.quality as ImageQuality,
        background: 'transparent',
        outputFormat: 'png',
        sceneCall: this.sceneCall(input),
      }),
    );
  }

  private sceneCall(input: SceneGenerateInput) {
    return { timeoutMs: this.timeoutMs(), correlationId: input.correlationId };
  }

  private async run(
    call: () => Promise<Awaited<ReturnType<OpenAiImageService['generateImage']>>>,
  ): Promise<SceneGenerateResult> {
    const startedAt = Date.now();
    try {
      const result = await call();
      return {
        buffer: result.image.buffer,
        usage: result.usage ?? null,
        costUsd: result.costUsd ?? null,
        requestId: result.requestId ?? null,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw classifySceneProviderError(error);
    }
  }

  private timeoutMs(): number {
    const value = Number(this.config.get<string>('OPENAI_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
  }
}
