import { Readable } from 'node:stream';
import type { ManualFetch } from './follow-redirects';
import { nodeRequest, PinnedRequest, PinnedResponse } from './pinned-request';
import { NameLookup, ResolvedAddress, resolvePublicAddresses } from './resolve-public-address';

export const DOWNLOAD_USER_AGENT = 'Mozilla/5.0 (compatible; Chroma/1.0)';

/** `accept-encoding: identity`: o `node:http` não descomprime, e sem compressão não há bomba de compressão. */
const requestHeaders = (url: URL): Record<string, string> => ({
  host: url.host,
  accept: 'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5',
  'accept-encoding': 'identity',
  'user-agent': DOWNLOAD_USER_AGENT,
  connection: 'close',
});

/** Erros de conexão: o próximo endereço conferido pode atender (IPv6 sem rota, primeiro IPv4 fora do ar). */
const CONNECTION_FAILURES = ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'];

const isConnectionFailure = (error: unknown): boolean =>
  CONNECTION_FAILURES.includes((error as { code?: string } | null)?.code ?? '');

/** Status sem corpo: o `Response` do Node recusa um stream com eles. */
const NO_BODY_STATUSES = [204, 205, 304];

async function connectToFirstReachable(
  addresses: ResolvedAddress[],
  url: URL,
  signal: AbortSignal,
  request: PinnedRequest,
): Promise<PinnedResponse> {
  const headers = requestHeaders(url);
  const last = addresses.length - 1;
  for (let index = 0; ; index++) {
    try {
      return await request({ url, address: addresses[index], headers, signal });
    } catch (error) {
      if (index === last || signal.aborted || !isConnectionFailure(error)) throw error;
    }
  }
}

function toResponse(incoming: PinnedResponse): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const each of Array.isArray(value) ? value : [value]) {
      if (each !== undefined) headers.append(name, each);
    }
  }
  const status = incoming.statusCode ?? 502;
  if (NO_BODY_STATUSES.includes(status)) {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
    status,
    headers,
  });
}

/**
 * O `fetch` do download seguro: resolve o nome do salto uma vez só, recusa se algum endereço for interno e conecta ao
 * primeiro endereço conferido (IPv4 antes de IPv6; em erro de conexão, ao próximo, dentro do mesmo prazo do `signal`).
 * Nenhum caminho conecta antes de conferir. Não segue redirecionamento: devolve a resposta 30x como veio.
 */
export function createPinnedFetch(
  deps: { lookup?: NameLookup; request?: PinnedRequest } = {},
): ManualFetch {
  const request = deps.request ?? nodeRequest;
  return async (rawUrl, { signal }) => {
    const url = new URL(rawUrl);
    const addresses = await resolvePublicAddresses(url.hostname, deps.lookup);
    return toResponse(await connectToFirstReachable(addresses, url, signal, request));
  };
}
