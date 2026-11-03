import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { buildItems, safeImagePath } from './label-items';
import { FIELD_VALUES, LabelError, readEntries, setLabel } from './label-store';
import { LABEL_PAGE } from './label-page';
import type { CasesFile } from './types';

const MIME: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const MAX_BODY = 4096;

function send(res: http.ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const json = (res: http.ServerResponse, status: number, data: unknown): void =>
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new LabelError(413, 'Corpo grande demais'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Servidor local (127.0.0.1) do rotulador: lê imagens só de `dir` e grava `labels.json` a cada clique. */
export function createLabelServer(dir: string, cases: CasesFile): http.Server {
  const items = buildItems(dir, cases);
  const keys = items.map((i) => i.key);
  const page = LABEL_PAGE.replace('__OPTS__', JSON.stringify(FIELD_VALUES));
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/')
        return send(res, 200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/items')
        return json(res, 200, { items, labels: readEntries(dir, keys) });
      if (req.method === 'GET' && url.pathname === '/img') {
        const file = safeImagePath(dir, url.searchParams.get('p') ?? '');
        if (!file) return json(res, 403, { error: 'Caminho fora da pasta de saída do spike' });
        if (!fs.existsSync(file)) return json(res, 404, { error: 'Imagem não encontrada' });
        return send(
          res,
          200,
          fs.readFileSync(file),
          MIME[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream',
        );
      }
      if (req.method === 'POST' && url.pathname === '/api/label') {
        const body = JSON.parse(await readBody(req)) as {
          key?: string;
          field?: string;
          value?: string | null;
        };
        const entry = setLabel(dir, keys, String(body.key), String(body.field), body.value ?? null);
        return json(res, 200, { entry });
      }
      return json(res, 404, { error: 'Rota desconhecida' });
    } catch (err) {
      const status = err instanceof LabelError ? err.status : 400;
      return json(res, status, { error: (err as Error).message });
    }
  });
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}
