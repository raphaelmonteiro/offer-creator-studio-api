import { Readable } from 'node:stream';
import type { PinnedRequest, PinnedRequestOptions, PinnedResponse } from './pinned-request';
import type { NameLookup, ResolvedAddress } from './resolve-public-address';

/** Resposta de uma conexão simulada: o stream com status e cabeçalhos, como o `IncomingMessage` do Node. */
export function connectionReply(
  body: Buffer | Readable,
  status = 200,
  headers: Record<string, string> = {},
): PinnedResponse {
  const stream = Buffer.isBuffer(body) ? Readable.from([body]) : body;
  return Object.assign(stream, { statusCode: status, headers });
}

export const redirectTo = (location: string, status = 302): PinnedResponse =>
  connectionReply(Buffer.alloc(0), status, { location });

/** O erro de conexão do Node (`ECONNREFUSED`...). */
export const connectionError = (code: string): Error =>
  Object.assign(new Error(`connect ${code}`), { code });

/** Tabela nome → endereços, com o contador de consultas por nome; nome fora da tabela não resolve. */
export function fakeLookup(table: Record<string, string[]>): jest.MockedFunction<NameLookup> {
  return jest.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const addresses = table[hostname];
    if (!addresses) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
}

/** Conexão simulada: `script` decide a resposta (ou o erro) por chamada; nada abre soquete. */
export function fakeRequest(
  script: (options: PinnedRequestOptions, call: number) => PinnedResponse | Error,
): jest.MockedFunction<PinnedRequest> {
  let call = 0;
  return jest.fn(async (options: PinnedRequestOptions) => {
    const outcome = script(options, call++);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
}

/** Os endereços a que as conexões foram feitas, na ordem. */
export const connectedTo = (request: jest.MockedFunction<PinnedRequest>): string[] =>
  request.mock.calls.map(([options]) => options.address.address);
