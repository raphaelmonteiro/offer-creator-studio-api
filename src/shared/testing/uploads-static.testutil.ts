import * as request from 'supertest';
import { binaryBody } from './binary-body.testutil';

/** Origem do front, como o navegador a manda ao pedir um arquivo de `/uploads/` de outra origem. */
const FRONT_ORIGIN = 'http://localhost:3110';

/** `GET <urlPath>` do estático de `/uploads/` sem token, com a `Origin` do front e o corpo lido como `Buffer`. */
export function fetchUploadsFile(server: Parameters<typeof request>[0], urlPath: string) {
  return request(server).get(urlPath).set('Origin', FRONT_ORIGIN).buffer(true).parse(binaryBody);
}

/** O que `useUploadsStatic` entrega: 200, os mesmos bytes do arquivo e os três cabeçalhos do `main.ts`. */
export function expectUploadsStaticResponse(response: request.Response, bytes: Buffer): void {
  expect(response.status).toBe(200);
  expect(Buffer.compare(response.body as Buffer, bytes)).toBe(0);
  expect(response.headers['access-control-allow-origin']).toBe('*');
  expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
  expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
}
