import { Response } from 'superagent';

/**
 * Lê o corpo da resposta como `Buffer` (o supertest não o entrega para um tipo que não conhece, como `font/ttf`).
 * Uso: `await request(server).get(url).buffer(true).parse(binaryBody)`.
 */
export function binaryBody(res: Response, done: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}
