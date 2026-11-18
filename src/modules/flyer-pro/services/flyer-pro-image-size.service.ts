import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { resolveUploadsDir } from '../../../common/config/uploads-dir';
import { fileUploadOptions } from '../../../common/utils/multer.util';
import { DEFAULT_CDN_URL } from '../../uploads/uploads.service';

export interface ImageSize {
  width: number;
  height: number;
}

/** Prazo do download de uma foto de fora (A-11). */
export const MEASURE_DOWNLOAD_TIMEOUT_MS = 10_000;
/** Teto do download: o mesmo do envio de arquivo (50 MB). */
export const MEASURE_DOWNLOAD_MAX_BYTES = fileUploadOptions.limits.fileSize;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
/** Segmento `..` do caminho, com `/` ou `\`. */
const PARENT_SEGMENT = /(^|[\\/])\.\.($|[\\/])/;

/** Onde a medida da foto se lê: no disco, baixando, ou em lugar nenhum (caminho que sai da pasta de uploads). */
type Source = { kind: 'disk'; file: string } | { kind: 'download' } | { kind: 'refused' };

/**
 * A medida (largura e altura) de uma foto da Galeria, como o navegador a mostra (orientação do arquivo aplicada): o motor
 * do encarte usa a proporção do arquivo (PU-29). Lê só o cabeçalho, com o `sharp`. A URL que começa pelo `CDN_URL` do
 * backend, ou de host local, é lida do disco dentro do `UPLOAD_DEST` quando o arquivo está lá; caminho que sai da pasta
 * vale como falha, sem baixar. Qualquer outra URL, e o arquivo que não está no disco deste processo (um worker que não
 * enxerga a pasta de uploads), é baixada com prazo de 10 s e teto de 50 MB. Qualquer falha devolve `null`, nunca uma
 * medida inventada (A-11).
 */
@Injectable()
export class FlyerProImageSizeService {
  constructor(private readonly config: ConfigService) {}

  async measure(url: string, signal?: AbortSignal): Promise<ImageSize | null> {
    const source = this.sourceOf(url);
    if (source.kind === 'refused') return null;
    if (source.kind === 'disk' && (await isFile(source.file))) return sizeOf(source.file);
    const downloaded = await this.download(url, signal);
    return downloaded ? sizeOf(downloaded) : null;
  }

  /** O caminho do arquivo sob o `UPLOAD_DEST` quando a URL é do próprio servidor; senão, baixar (ou recusar). */
  private sourceOf(url: string): Source {
    const relative = this.uploadsRelativeOf(url);
    if (relative === null) return { kind: 'download' };
    if (relative === '' || PARENT_SEGMENT.test(safeDecode(relative))) return { kind: 'refused' };
    const uploadsDir = resolveUploadsDir(this.config.get<string>('UPLOAD_DEST'));
    const file = path.resolve(uploadsDir, safeDecode(relative));
    return file.startsWith(uploadsDir + path.sep) ? { kind: 'disk', file } : { kind: 'refused' };
  }

  /** O trecho da URL depois da pasta de uploads, se ela é do próprio servidor (`CDN_URL` ou host local); senão `null`. */
  private uploadsRelativeOf(url: string): string | null {
    const cdn = this.config.get<string>('CDN_URL', DEFAULT_CDN_URL).replace(/\/+$/, '');
    if (url.startsWith(`${cdn}/`)) return withoutQuery(url.slice(cdn.length + 1));
    const [rawPath, host] = pathAndHost(url);
    if (host !== null && !LOCAL_HOSTS.has(host)) return null;
    const marker = /\/uploads\/+/.exec(rawPath);
    return marker ? rawPath.slice(marker.index + marker[0].length) : null;
  }

  /** Baixa a foto com prazo e teto; `null` em qualquer falha (rede, status, prazo, teto). */
  private async download(url: string, signal?: AbortSignal): Promise<Buffer | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, MEASURE_DOWNLOAD_TIMEOUT_MS);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok || !response.body) return null;
      return await readUpTo(response.body, MEASURE_DOWNLOAD_MAX_BYTES);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

/** O arquivo está no disco deste processo? */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** A medida do cabeçalho (arquivo ou bytes) com a orientação do arquivo aplicada; `null` se não é imagem. */
async function sizeOf(input: string | Buffer): Promise<ImageSize | null> {
  try {
    const { width, height, orientation } = await sharp(input).metadata();
    if (!width || !height) return null;
    // EXIF 5 a 8: a imagem é exibida girada em 90 graus, e a proporção que o card usa é a da exibição.
    return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
  } catch {
    return null;
  }
}

/** Lê o corpo até o teto; passou dele, para a leitura e devolve `null`. */
async function readUpTo(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const withoutQuery = (text: string): string => text.split(/[?#]/)[0];

/** O caminho cru (sem consulta nem âncora, sem normalizar `..`) e o host da URL; `host` é `null` na URL relativa. */
function pathAndHost(url: string): [string, string | null] {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(.*)$/i.exec(url);
  if (!absolute) return [withoutQuery(url), null];
  const host = absolute[1].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
  return [withoutQuery(absolute[2]), host];
}
