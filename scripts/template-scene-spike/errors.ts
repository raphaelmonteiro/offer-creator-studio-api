import { TerminalProviderError } from '../../src/shared/providers/provider-errors';
import { openAiQuotaCode } from '../../src/shared/providers/openai-errors';
import type { Arm, StopCode } from './budget';

export interface ErrorClass {
  /** Parada imediata, sem retentativa (P2). */
  stop?: StopCode;
  /** 400 que cita `mask` ou `markup` (P3). */
  refusedArm?: Arm;
  code: string;
  message: string;
}

interface HttpErrorShape {
  status?: number;
  code?: string | null;
  message?: string;
  error?: { code?: string | null; message?: string } | null;
}

/** Classifica o erro de uma chamada (já passado por `withOpenAiRetry`). Nunca inclui chave. */
export function classifyCallError(err: unknown): ErrorClass {
  const shape = (err ?? {}) as HttpErrorShape;
  const message = String(shape.message ?? shape.error?.message ?? err);
  const code = String(shape.code ?? shape.error?.code ?? '');
  if (err instanceof TerminalProviderError && err.code === 'quota') {
    return { stop: 'quota', code: openAiQuotaCode(err) ?? 'quota', message };
  }
  if (openAiQuotaCode(err)) return { stop: 'quota', code: openAiQuotaCode(err), message };
  if (shape.status === 401 || shape.status === 403) {
    return { stop: 'auth', code: code || String(shape.status), message };
  }
  if (shape.status === 404 || code === 'model_not_found') {
    return { stop: 'model', code: code || 'model_not_found', message };
  }
  if (shape.status === 400) {
    const lower = message.toLowerCase();
    const refusedArm: Arm | undefined = lower.includes('markup')
      ? 'markup'
      : lower.includes('mask')
        ? 'mask'
        : undefined;
    return { refusedArm, code: code || '400', message };
  }
  return { code: code || String(shape.status ?? 'error'), message };
}
