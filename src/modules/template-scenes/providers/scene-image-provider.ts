import { ImageUsage } from '../../../shared/image/openai-image-capabilities';
import { SceneFailureCode } from '../domain/scene.types';

/** Token de injeção do provedor de imagem da cena (`mock` ou `openai`, D-2). */
export const SCENE_IMAGE_PROVIDER = 'SCENE_IMAGE_PROVIDER';

export interface SceneGenerateInput {
  model: string;
  prompt: string;
  /** `LARGURAxALTURA` em pixels. */
  size: string;
  quality: string;
  /** Liga as linhas de log da chamada à cena e à versão. */
  correlationId: string;
}

export interface SceneGenerateResult {
  /** Imagem PNG no tamanho pedido. */
  buffer: Buffer;
  usage: ImageUsage | null;
  /** Custo em USD; `null` quando o modelo não tem preço conferido. */
  costUsd: number | null;
  requestId: string | null;
  latencyMs: number;
}

export interface SceneEditInput extends SceneGenerateInput {
  /** PNG enviado: a master inteira da versão atual, no tamanho nativo. */
  image: Buffer;
  /**
   * Camada de marcação: PNG transparente do tamanho de `image` com o contorno da forma marcada. Ausente
   * quando o cliente não marcou nada (o código nunca gera marcação sozinho).
   */
  markup?: Buffer;
}

/**
 * Porta do provedor de imagem da cena (D-2): `generate` (primeira imagem e imagem nova, sem referência) e `edit`
 * (redesenho da imagem inteira, com `markup` quando o cliente marcou). Sem máscara e sem PNG transparente (D-22, D-33).
 * Falha do provedor vira `SceneProviderError` com o código que a versão grava.
 */
export interface SceneImageProvider {
  readonly name: 'mock' | 'openai';
  generate(input: SceneGenerateInput): Promise<SceneGenerateResult>;
  edit(input: SceneEditInput): Promise<SceneGenerateResult>;
}

/** Falha do provedor já classificada para a versão (`errorCode`). */
export class SceneProviderError extends Error {
  constructor(
    readonly code: Extract<
      SceneFailureCode,
      'PROVIDER_QUOTA' | 'PROVIDER_CONTENT_POLICY' | 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR'
    >,
    message: string,
    /** Custo já cobrado pela resposta que falhou depois (imagem ilegível); `null` = nada cobrado/desconhecido. */
    readonly costUsd: number | null = null,
  ) {
    super(message);
    this.name = 'SceneProviderError';
  }
}
