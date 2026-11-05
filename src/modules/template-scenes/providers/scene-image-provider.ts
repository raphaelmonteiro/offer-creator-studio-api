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
  /** PNG enviado: o recorte da edição local, ou a master inteira no ajuste geral. */
  image: Buffer;
  /** PNG da máscara (alfa 255 = editar) do tamanho de `image`; ausente no ajuste geral. */
  mask?: Buffer;
  /**
   * PNG (alfa 255 = pintar) do tamanho de `image` com só a forma S. Serve ao provedor `mock`, para não
   * pintar a faixa R \ S (PV-30); o provedor `openai` ignora o campo e o corpo enviado não muda.
   */
  paintMask?: Buffer;
}

/**
 * Porta do provedor de imagem da cena (D-2): `generate` (primeira geração), `edit` (edição local com
 * máscara ou ajuste geral sem ela) e `generateTransparent` (PNG com fundo transparente do "adicionar").
 * Falha do provedor vira `SceneProviderError` com o código que a versão grava.
 */
export interface SceneImageProvider {
  readonly name: 'mock' | 'openai';
  generate(input: SceneGenerateInput): Promise<SceneGenerateResult>;
  edit(input: SceneEditInput): Promise<SceneGenerateResult>;
  generateTransparent(input: SceneGenerateInput): Promise<SceneGenerateResult>;
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
