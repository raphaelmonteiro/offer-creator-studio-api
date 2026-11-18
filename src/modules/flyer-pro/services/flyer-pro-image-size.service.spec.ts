import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import {
  FlyerProImageSizeService,
  MEASURE_DOWNLOAD_MAX_BYTES,
  MEASURE_DOWNLOAD_TIMEOUT_MS,
} from './flyer-pro-image-size.service';

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'flyer-pro-image-size-'));
const CDN = 'http://cdn.exemplo.test/uploads';
afterAll(() => fs.rmSync(uploads, { recursive: true, force: true }));

const service = new FlyerProImageSizeService(fakeConfig({ UPLOAD_DEST: uploads, CDN_URL: CDN }));

/** Nenhuma requisição sai dos testes: o `fetch` é simulado e, sem resposta combinada, recusa a conexão. */
let fetchSpy: jest.SpyInstance;
beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('sem rede nos testes'));
});
afterEach(() => {
  jest.useRealTimers();
  fetchSpy.mockRestore();
});

async function jpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: '#cc0000' } }).jpeg();
  return (orientation ? image.withMetadata({ orientation }) : image).toBuffer();
}

/** A resposta HTTP de uma imagem (o corpo do `Response` pede bytes, não `Buffer`). */
const imageResponse = (bytes: Buffer): Response => new Response(new Uint8Array(bytes));

/** Grava uma imagem de teste em `gallery/` do `UPLOAD_DEST` e devolve a URL como a Galeria a guarda. */
async function writePhoto(name: string, width: number, height: number, orientation?: number) {
  fs.mkdirSync(path.join(uploads, 'gallery'), { recursive: true });
  fs.writeFileSync(path.join(uploads, 'gallery', name), await jpeg(width, height, orientation));
  return `http://localhost:3101/uploads/gallery/${name}`;
}

describe('FlyerProImageSizeService: arquivo no disco do processo', () => {
  it('lê a largura e a altura do arquivo local: a garrafa em pé de 600×1200', async () => {
    const url = await writePhoto('coca-cola-2l.jpg', 600, 1200);

    expect(await service.measure(url)).toEqual({ width: 600, height: 1200 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a URL pelo CDN_URL e a relativa acham o mesmo arquivo, sem baixar', async () => {
    await writePhoto('abacate.jpg', 800, 400);

    expect(await service.measure(`${CDN}/gallery/abacate.jpg?v=2`)).toEqual({
      width: 800,
      height: 400,
    });
    expect(await service.measure('/uploads/gallery/abacate.jpg')).toEqual({
      width: 800,
      height: 400,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('foto girada pelo EXIF (orientação 6): a proporção é a da exibição', async () => {
    const url = await writePhoto('girada.jpg', 400, 100, 6);

    expect(await service.measure(url)).toEqual({ width: 100, height: 400 });
  });

  it('arquivo que não é imagem: null, sem lançar e sem baixar', async () => {
    fs.mkdirSync(path.join(uploads, 'gallery'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'gallery', 'quebrada.jpg'), 'isto não é uma imagem');

    expect(await service.measure('/uploads/gallery/quebrada.jpg')).toBeNull();
    expect(await service.measure(`${CDN}/gallery/quebrada.jpg`)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FlyerProImageSizeService: arquivo apagado do disco', () => {
  it('URL do próprio servidor sem o arquivo: tenta o endereço público e, sem resposta, a medida não vem', async () => {
    expect(await service.measure(`${CDN}/gallery/apagada.jpg`)).toBeNull();
    expect(await service.measure('http://localhost:3101/uploads/gallery/apagada.jpg')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('URL de host local fora de /uploads/ não é arquivo do disco: baixa, e sem resposta a medida não vem', async () => {
    expect(await service.measure('http://localhost:3101/gallery/coca-cola-2l.jpg')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FlyerProImageSizeService: caminho para fora da pasta de uploads', () => {
  it.each([
    ['URL local com /uploads/../.env', 'http://localhost:3101/uploads/../.env'],
    ['relativa que escapa', '/uploads/../../etc/passwd'],
    ['escapando por %2e%2e', '/uploads/%2e%2e/%2e%2e/etc/passwd'],
    ['pelo CDN_URL', `${CDN}/../.env`],
    ['pelo CDN_URL, com barra invertida', `${CDN}/gallery/..\\..\\.env`],
    ['só a pasta', '/uploads/'],
  ])('%s: nada é lido nem baixado e a medida não vem', async (_, url) => {
    expect(await service.measure(url)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FlyerProImageSizeService: download de URL de fora', () => {
  it('foto de outro endereço: baixa e mede, com a orientação do arquivo', async () => {
    fetchSpy.mockResolvedValue(imageResponse(await jpeg(800, 640)));
    expect(await service.measure('https://fotos.exemplo.com/cerveja.jpg')).toEqual({
      width: 800,
      height: 640,
    });

    fetchSpy.mockResolvedValue(imageResponse(await jpeg(1200, 900, 6)));
    expect(await service.measure('https://fotos.exemplo.com/girada.jpg')).toEqual({
      width: 900,
      height: 1200,
    });
  });

  it('o mesmo /uploads/ de outro endereço não é lido do disco: baixa', async () => {
    await writePhoto('so-no-disco.jpg', 10, 10);
    fetchSpy.mockResolvedValue(imageResponse(await jpeg(800, 640)));

    expect(
      await service.measure('https://cdn.exemplo.com/uploads/gallery/so-no-disco.jpg'),
    ).toEqual({
      width: 800,
      height: 640,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('endereço que não responde em 10 s: a medida não vem e o download é cancelado', async () => {
    jest.useFakeTimers();
    let sent: AbortSignal | undefined;
    fetchSpy.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          sent = init.signal;
          init.signal.addEventListener('abort', () => reject(new Error('abortado')));
        }),
    );

    const measuring = service.measure('https://lento.exemplo.com/foto.jpg');
    await jest.advanceTimersByTimeAsync(MEASURE_DOWNLOAD_TIMEOUT_MS - 1);
    expect(sent?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(await measuring).toBeNull();
    expect(sent?.aborted).toBe(true);
    expect(MEASURE_DOWNLOAD_TIMEOUT_MS).toBe(10_000);
  });

  it('corpo que trava no meio do download: o prazo também vale para a leitura', async () => {
    jest.useFakeTimers();
    fetchSpy.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new Error('abortado')));
        },
      });
      return new Response(body);
    });

    const measuring = service.measure('https://lento.exemplo.com/foto.jpg');
    await jest.advanceTimersByTimeAsync(MEASURE_DOWNLOAD_TIMEOUT_MS);

    expect(await measuring).toBeNull();
  });

  it('arquivo grande demais (60 MB): o download para no teto de 50 MB e a medida não vem', async () => {
    const mb = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 60) controller.close();
        else controller.enqueue(mb);
      },
    });
    fetchSpy.mockResolvedValue(new Response(body));

    expect(await service.measure('https://grande.exemplo.com/foto.jpg')).toBeNull();
    expect(MEASURE_DOWNLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
    // para de ler logo depois do teto, sem consumir o resto
    expect(pulled).toBeLessThan(60);
  });

  it.each([
    ['404', new Response('não achei', { status: 404 })],
    ['500', new Response('erro', { status: 500 })],
    ['corpo que não é imagem', new Response('<html></html>')],
  ])('resposta %s: a medida não vem', async (_, response) => {
    fetchSpy.mockResolvedValue(response);
    expect(await service.measure('https://fotos.exemplo.com/x.jpg')).toBeNull();
  });

  it('o sinal abortado do lote cancela o download', async () => {
    const controller = new AbortController();
    let sent: AbortSignal | undefined;
    fetchSpy.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          sent = init.signal;
          init.signal.addEventListener('abort', () => reject(new Error('abortado')));
        }),
    );

    const measuring = service.measure('https://fotos.exemplo.com/x.jpg', controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    expect(await measuring).toBeNull();
    expect(sent?.aborted).toBe(true);
  });

  it('arquivo ausente do disco e URL relativa: nada a baixar, a medida não vem', async () => {
    expect(await service.measure('/uploads/gallery/apagada.jpg')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('URL vazia ou que não é http: a medida não vem', async () => {
    expect(await service.measure('')).toBeNull();
    expect(await service.measure('ftp://x/uploads2/foto.jpg')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('FlyerProImageSizeService: worker sem a pasta de uploads', () => {
  it('foto pelo CDN_URL que o servidor entrega: a medida vem do download pelo endereço público', async () => {
    fetchSpy.mockRestore();
    const photo = await jpeg(600, 1200);
    const server = http.createServer((request, response) => {
      if (request.url === '/uploads/gallery/so-no-servidor.jpg') response.end(photo);
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyer-pro-worker-sem-uploads-'));
    const worker = new FlyerProImageSizeService(
      fakeConfig({ UPLOAD_DEST: emptyDir, CDN_URL: `http://127.0.0.1:${port}/uploads` }),
    );

    try {
      expect(
        await worker.measure(`http://127.0.0.1:${port}/uploads/gallery/so-no-servidor.jpg`),
      ).toEqual({ width: 600, height: 1200 });
      expect(
        await worker.measure(`http://127.0.0.1:${port}/uploads/gallery/apagada.jpg`),
      ).toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
