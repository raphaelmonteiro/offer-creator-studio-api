/** Mais redirecionamentos que o teto. */
export class RedirectLimitError extends Error {
  constructor(max: number) {
    super(`redirects demais (mais de ${max})`);
    this.name = 'RedirectLimitError';
  }
}

/** Redirecionamento sem `Location`. */
export class RedirectLocationError extends Error {
  constructor(status: number) {
    super(`redirect sem Location (${status})`);
    this.name = 'RedirectLocationError';
  }
}

/** O `fetch` que o seguidor usa: sempre `redirect: 'manual'`, para ver cada salto. */
export type ManualFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'manual' },
) => Promise<Response>;

export interface FollowRedirectsOptions {
  fetch: ManualFetch;
  signal: AbortSignal;
  maxRedirects: number;
  /** Confere a URL antes de cada requisição, a primeira inclusive; lança para recusar. */
  checkUrl: (url: string) => void | Promise<void>;
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** Segue os redirecionamentos à mão, até `maxRedirects`, passando cada endereço por `checkUrl` antes de pedi-lo. */
export async function fetchFollowingRedirects(
  startUrl: string,
  { fetch, signal, maxRedirects, checkUrl }: FollowRedirectsOptions,
): Promise<Response> {
  let url = startUrl;
  for (let hop = 0; ; hop++) {
    await checkUrl(url);
    const res = await fetch(url, { signal, redirect: 'manual' });
    if (!REDIRECT_STATUSES.includes(res.status)) return res;
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    if (!location) throw new RedirectLocationError(res.status);
    if (hop >= maxRedirects) throw new RedirectLimitError(maxRedirects);
    url = new URL(location, url).toString();
  }
}
