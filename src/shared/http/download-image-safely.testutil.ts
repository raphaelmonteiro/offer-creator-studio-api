import type { ManualFetch } from './follow-redirects';

/** Resposta de imagem com o `content-type` pedido (padrão `image/jpeg`). */
export const imageResponse = (
  body: Buffer | ReadableStream<Uint8Array>,
  headers: Record<string, string> = { 'content-type': 'image/jpeg' },
  status = 200,
): Response => new Response(body as BodyInit, { status, headers });

/** `fetch` que responde pela tabela URL → resposta (ou função que a monta); URL fora dela é erro do teste. */
export function fetchFrom(
  routes: Record<string, Response | (() => Response)>,
): jest.MockedFunction<ManualFetch> {
  return jest.fn<Promise<Response>, Parameters<ManualFetch>>(async (url) => {
    const route = routes[url];
    if (!route) throw new Error(`URL sem rota no teste: ${url}`);
    return typeof route === 'function' ? route() : route;
  });
}

/** Corpo em pedaços de `chunk` bytes até `total`; `seen.pulled` conta os pedaços puxados (a leitura que para não puxa o resto). */
export function chunkedBody(total: number, chunk: number) {
  const seen = { pulled: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) return controller.close();
        const length = Math.min(chunk, total - sent);
        sent += length;
        seen.pulled += 1;
        controller.enqueue(new Uint8Array(length));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, seen };
}
