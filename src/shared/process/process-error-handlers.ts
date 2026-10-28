import { hasChildWorkInFlight } from './in-flight-child-work';

/** Carência (ms) do encerramento controlado do worker antes do `exit(1)` (change corrigir-render-remotion-epipe, D1c). */
export const WORKER_FATAL_GRACE_MS = 10_000;

const PIPE_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'ENOEXEC']);

/**
 * Erro de pipe de um processo filho (compositor/Chromium): escrita em stream de processo morto ou `spawn`
 * que falhou ao executar. Pura; o contexto "há processo filho em uso" é checado por quem a chama.
 */
export function isChildPipeError(err: unknown): boolean {
  const { code, syscall } = (err ?? {}) as { code?: unknown; syscall?: unknown };
  if (typeof code !== 'string') return false;
  if (PIPE_CODES.has(code)) return true;
  return SPAWN_CODES.has(code) && typeof syscall === 'string' && syscall.startsWith('spawn');
}

export interface ProcessErrorLogger {
  error(message: string, stack?: string): void;
}

/** Superfície usada do `process` (injetável nos testes). */
export interface ProcessLike {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (reason: unknown) => void,
  ): unknown;
  exitCode?: number | string;
}

export interface ProcessErrorHandlerOptions {
  logger: ProcessErrorLogger;
  /** Para os consumidores e fecha o app (`app.close()`); chamado no erro fatal. */
  shutdown: () => Promise<unknown>;
  exit: (code: number) => void;
  graceMs?: number;
  /** Há trabalho de processo filho em andamento (padrão: o contador do render). */
  hasChildWork?: () => boolean;
}

function describeError(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    const code = (reason as { code?: unknown }).code;
    return { message: code ? `${code} ${reason.message}` : reason.message, stack: reason.stack };
  }
  return { message: String(reason) };
}

/**
 * Política do worker para erro que escapou de qualquer `try` (design D1c). Todo erro é registrado em nível
 * `error` com mensagem e pilha ANTES de qualquer decisão; nenhum é engolido.
 *
 * - erro de pipe de processo filho com render em andamento: segue de pé (o step falha pela promessa);
 * - `unhandledRejection` de outro tipo: segue de pé (promessa esquecida não corrompe o processo);
 * - `uncaughtException` desconhecida: encerramento controlado (`shutdown()` limitado a `graceMs`, depois
 *   `exit(1)`) para o PM2 reiniciar; segunda exceção durante o encerramento só é registrada.
 */
export function installProcessErrorHandlers(
  proc: ProcessLike,
  options: ProcessErrorHandlerOptions,
): void {
  const { logger, shutdown, exit } = options;
  const graceMs = options.graceMs ?? WORKER_FATAL_GRACE_MS;
  const hasChildWork = options.hasChildWork ?? hasChildWorkInFlight;
  let shuttingDown = false;

  const terminate = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    proc.exitCode = 1;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([(async () => shutdown())(), limit]);
    } catch (err) {
      logger.error(`Falha no encerramento do worker: ${describeError(err).message}`);
    } finally {
      if (timer) clearTimeout(timer);
      exit(1);
    }
  };

  proc.on('uncaughtException', (err) => {
    const { message, stack } = describeError(err);
    if (shuttingDown) {
      logger.error(`uncaughtException durante o encerramento: ${message}`, stack);
    } else if (isChildPipeError(err) && hasChildWork()) {
      logger.error(
        `Erro de pipe de processo filho durante o render (reconhecido; o step falha pela promessa): ${message}`,
        stack,
      );
    } else {
      logger.error(`uncaughtException fatal: encerrando o worker: ${message}`, stack);
      void terminate();
    }
  });

  proc.on('unhandledRejection', (reason) => {
    const { message, stack } = describeError(reason);
    if (isChildPipeError(reason) && hasChildWork()) {
      logger.error(
        `Erro de pipe de processo filho durante o render (reconhecido; o step falha pela promessa): ${message}`,
        stack,
      );
    } else {
      logger.error(`unhandledRejection não reconhecida (worker segue): ${message}`, stack);
    }
  });
}
