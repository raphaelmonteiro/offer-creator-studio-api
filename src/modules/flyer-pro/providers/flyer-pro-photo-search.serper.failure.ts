import {
  ProviderTimeoutError,
  TerminalProviderError,
  PROVIDER_AUTH_CODE,
  PROVIDER_QUOTA_CODE,
} from '../../../shared/providers/provider-errors';
import { PhotoSearchFailure } from './flyer-pro-photo-search.port';
import type { PhotoSearchFailureReason } from '../domain/flyer-pro-photo-search.errors';

/**
 * Falta de saldo da Serper, reconhecida só aqui (D-orq-252): a forma provável é 400 `{"message":"Not enough credits"}`, que
 * o classificador comum não reconhece (e não deve reconhecer: o 400 de outro fornecedor é outra coisa). O texto vem do
 * corpo da recusa, que `TerminalProviderError` guarda na mensagem.
 */
const OUT_OF_CREDITS = /not enough credits|insufficient credits|out of credits/i;

/** O status HTTP que a mensagem do erro do provedor traz (`HTTP 400: …`), ou `undefined` (queda de rede, prazo). */
function httpStatusOf(error: unknown): number | undefined {
  const match = error instanceof Error ? /^HTTP (\d{3})/.exec(error.message) : null;
  return match ? Number(match[1]) : undefined;
}

function terminalReason(error: TerminalProviderError): PhotoSearchFailureReason {
  if (OUT_OF_CREDITS.test(error.message)) return 'QUOTA';
  if (error.code === PROVIDER_QUOTA_CODE) return 'QUOTA';
  return error.code === PROVIDER_AUTH_CODE ? 'AUTH' : 'PROVIDER_ERROR';
}

/**
 * O motivo da falha da busca: `TIMEOUT` só para o prazo vencido (`ProviderTimeoutError`), `AUTH` e `QUOTA` pela recusa, e
 * `PROVIDER_ERROR` no resto (5xx, 429, queda de rede, outra recusa, resposta fora da forma). A mensagem nunca leva o corpo
 * da recusa, a URL nem a chave.
 */
export function searchFailureOf(error: unknown): PhotoSearchFailure {
  if (error instanceof PhotoSearchFailure) return error;
  const httpStatus = httpStatusOf(error);
  const reason: PhotoSearchFailureReason =
    error instanceof ProviderTimeoutError
      ? 'TIMEOUT'
      : error instanceof TerminalProviderError
        ? terminalReason(error)
        : 'PROVIDER_ERROR';
  return new PhotoSearchFailure(
    reason,
    `Busca de fotos falhou (${reason}${httpStatus ? `, HTTP ${httpStatus}` : ''})`,
    httpStatus,
  );
}
