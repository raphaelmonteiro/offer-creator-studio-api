import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiImageService } from '../../ai/openai-image.service';
import { SCENE_INVALID_REQUEST_CODE, SCENE_TIMEOUT_CODE } from '../../ai/openai-image-scene-call';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import {
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
    const startedAt = Date.now();
    try {
      const result = await this.images.generateImage({
        feature: 'template-scene',
        prompt: input.prompt,
        size: input.size as ImageSize,
        assetKind: 'template',
        model: input.model,
        quality: input.quality as ImageQuality,
        outputFormat: 'png',
        sceneCall: { timeoutMs: this.timeoutMs(), correlationId: input.correlationId },
      });
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
