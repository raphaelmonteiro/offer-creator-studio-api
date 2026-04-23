const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: init?.signal ?? controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`Timeout ao buscar recurso externo após ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
