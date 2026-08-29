/**
 * Erros/retry moveram para src/shared/providers/provider-errors.ts (mesma
 * extração de http-provider.base e elevenlabs.provider — plano-comerciais
 * §11). O reexport preserva os imports existentes deste módulo; os tipos de
 * submit/status de VÍDEO continuam aqui porque são vocabulário dos providers
 * de animação, não infraestrutura neutra.
 */
export {
  TerminalProviderError,
  TransientProviderError,
  withRetry,
} from '../../../shared/providers/provider-errors';

export interface ProviderSubmitResult {
  providerJobId: string;
}

export type ProviderJobState = 'processing' | 'succeeded' | 'failed';

export interface ProviderStatusResult {
  state: ProviderJobState;
  /** URL do resultado quando succeeded (vídeo/áudio/imagem). */
  outputUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  costUsd?: number;
}
