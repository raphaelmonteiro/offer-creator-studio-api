import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import type { ResolvedAddress } from './resolve-public-address';

/** A resposta que a conexão devolve: um stream com o status e os cabeçalhos (o `IncomingMessage` do Node). */
export type PinnedResponse = Readable & { statusCode?: number; headers: IncomingHttpHeaders };

export interface PinnedRequestOptions {
  url: URL;
  /** O endereço já conferido: a conexão vai a ele, nunca ao nome. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** Abre a conexão ao endereço conferido e resolve quando os cabeçalhos da resposta chegam. */
export type PinnedRequest = (options: PinnedRequestOptions) => Promise<PinnedResponse>;

/**
 * `GET` por `node:http`/`node:https`, com o host da conexão igual ao endereço conferido: o nome não é resolvido de novo
 * entre a conferência e a conexão. O nome vai no cabeçalho `Host` e, em https, no `servername` (SNI e conferência do certificado
 * pelo nome, não pelo IP); `agent: false` e `connection: close` não deixam soquete servir a outro endereço.
 */
export const nodeRequest: PinnedRequest = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const options = {
      host: address.address,
      port: Number(url.port) || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      agent: false,
      signal,
      // O SNI nunca é um endereço escrito: nesse caso o certificado é conferido contra o próprio endereço.
      servername: secure && isIP(hostname) === 0 ? hostname : undefined,
    };
    const req = (secure ? httpsRequest : httpRequest)(options, resolve);
    req.once('error', reject);
    req.end();
  });
