import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McRenderInterruptedError } from '../domain/mc-error-classes';

/** Fase do render em que o erro aconteceu (entra na mensagem técnica do step, nunca na UI). */
export type McRenderPhase =
  | 'bundle'
  | 'open_browser'
  | 'select_composition'
  | 'render_media'
  | 'render_still';

const DEATH_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_IPC_CHANNEL_CLOSED',
]);

/** Trechos observados ou lidos no Remotion 4.0.529 quando o compositor ou o Chromium morre. */
const DEATH_MESSAGE =
  /Compositor quit|Could not extract frame from compositor|browser crashed|Target closed|Session closed|browser has disconnected|Browser closed|Protocol error|Timed out after \d+ ms while trying to connect to the browser|SIGKILL|SIGSEGV|SIGABRT|out of memory/i;

/** true quando o erro é da morte de um processo do render (compositor ou Chromium), em qualquer fase. */
export function isProcessDeath(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && DEATH_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return DEATH_MESSAGE.test(message);
}

/**
 * Converte a falha do render em `McRenderInterruptedError` (código `render_interrupted`) quando o processo
 * morreu ou o Chromium não subiu; o resto (mídia 404, delayRender, cancelamento por prazo, bundle) segue como
 * veio, para não esconder causa de conteúdo. Erro tipado terminal (`RENDER_UNAVAILABLE` etc.) passa intacto.
 */
export function toRenderFailure(err: unknown, phase: McRenderPhase): unknown {
  if (err instanceof McRenderInterruptedError || err instanceof TerminalProviderError) return err;
  if (phase !== 'open_browser' && !isProcessDeath(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new McRenderInterruptedError(phase, message, { cause: err });
}
