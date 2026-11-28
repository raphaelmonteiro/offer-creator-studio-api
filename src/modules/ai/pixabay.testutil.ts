import { jpegOf, paddedTo } from '../../shared/image/image-fixtures.testutil';
import type { ManualFetch } from '../../shared/http/follow-redirects';
import { createPinnedFetch } from '../../shared/http/pinned-fetch';
import type { PinnedResponse } from '../../shared/http/pinned-request';
import { connectionReply, fakeLookup, fakeRequest } from '../../shared/http/pinned-fetch.testutil';

/** A foto de teste do Pixabay: a mesma de `/v1/ai/image-download` nos specs do serviço e do contrato. */
export const PIXABAY_PHOTO_URL = 'https://pixabay.com/get/g1a2b3c4d5e6f_1280.jpg';

/** JPEG de verdade com `bytes` bytes exatos (zeros depois do fim do arquivo não impedem a decodificação). */
export async function pixabayPhoto(bytes = 2048): Promise<Buffer> {
  return paddedTo(await jpegOf(64, 48), bytes);
}

/** A resposta do Pixabay com o arquivo; `contentLength` só entra quando o teste o informa. */
export function pixabayFile(
  body: Buffer,
  options: { contentLength?: number; contentType?: string } = {},
): PinnedResponse {
  const headers: Record<string, string> = { 'content-type': options.contentType ?? 'image/jpeg' };
  if (options.contentLength !== undefined)
    headers['content-length'] = String(options.contentLength);
  return connectionReply(body, 200, headers);
}

export const pixabayMissing = (status = 404): PinnedResponse =>
  connectionReply(Buffer.alloc(0), status);

/**
 * O `fetch` do download com a conexão simulada: `pixabay.com` e `cdn.pixabay.com` resolvem para um endereço público, e
 * `reply` decide a resposta de cada conexão (nenhum teste abre soquete nem consulta DNS). `request` conta as conexões.
 */
export function pixabayFetch(reply: () => PinnedResponse | Error): {
  fetch: ManualFetch;
  request: ReturnType<typeof fakeRequest>;
} {
  const lookup = fakeLookup({ 'pixabay.com': ['203.0.113.7'], 'cdn.pixabay.com': ['203.0.113.8'] });
  const request = fakeRequest(reply);
  return { fetch: createPinnedFetch({ lookup, request }), request };
}
