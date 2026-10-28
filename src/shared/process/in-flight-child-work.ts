/**
 * Contador de trabalho de PROCESSO FILHO em andamento neste processo (compositor e Chromium do Remotion).
 *
 * Serve ao handler de erro do worker: um `EPIPE` assíncrono tem pilha só de quadros internos do Node, então
 * reconhecê-lo pelo texto da pilha seria frágil; reconhece-se por CONTEXTO (há render em curso). Ver
 * `process-error-handlers.ts` e a change corrigir-render-remotion-epipe (design D1c).
 */
let inFlight = 0;

/** Roda `work` contando-o como trabalho de processo filho, até resolver ou rejeitar. */
export async function trackChildWork<T>(work: () => Promise<T>): Promise<T> {
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
  }
}

export function hasChildWorkInFlight(): boolean {
  return inFlight > 0;
}
