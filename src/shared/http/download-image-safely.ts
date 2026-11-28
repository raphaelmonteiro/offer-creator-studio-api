import { readImage, ReadableFormat } from '../image/read-image';
import {
  fetchFollowingRedirects,
  ManualFetch,
  RedirectLimitError,
  RedirectLocationError,
} from './follow-redirects';
import { createPinnedFetch } from './pinned-fetch';
import { readBodyUpTo } from './read-body-up-to';
import { SafeDownloadError } from './safe-download-error';

export const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
export const DOWNLOAD_MAX_REDIRECTS = 3;

const FORMAT_FILES: Record<ReadableFormat, { extension: string; mimeType: string }> = {
  jpeg: { extension: '.jpg', mimeType: 'image/jpeg' },
  png: { extension: '.png', mimeType: 'image/png' },
  webp: { extension: '.webp', mimeType: 'image/webp' },
  gif: { extension: '.gif', mimeType: 'image/gif' },
};

export interface DownloadImageOptions {
  /** Padrão: a conexão presa ao endereço conferido (`createPinnedFetch`). Injetável no teste. */
  fetch?: ManualFetch;
  /** Regra a mais do chamador, conferida no primeiro endereço e em cada salto (host e porta do Pixabay); `false` recusa com `SCHEME`. */
  allowUrl?: (url: URL) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

/** A foto baixada, lida pelo conteúdo: o tipo e a extensão vêm do formato decodificado, não do `content-type`. */
export interface DownloadedImage {
  buffer: Buffer;
  format: ReadableFormat;
  /** Medida do arquivo, com a orientação aplicada (primeiro quadro no GIF). */
  width: number;
  height: number;
  /** Com o ponto: `.jpg`, `.png`, `.webp` ou `.gif`. */
  extension: string;
  mimeType: string;
}

/** Só http e https, sem usuário e senha, e a regra a mais do chamador: antes de qualquer requisição a este endereço. */
function checkUrlOf(allowUrl: DownloadImageOptions['allowUrl']) {
  return (raw: string): void => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new SafeDownloadError('SCHEME', 'URL inválida');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SafeDownloadError('SCHEME', `esquema não aceito (${url.protocol})`);
    }
    if (url.username || url.password) {
      throw new SafeDownloadError('SCHEME', 'URL com usuário e senha');
    }
    if (allowUrl && !allowUrl(url)) {
      throw new SafeDownloadError('SCHEME', `endereço não permitido (${url.host})`);
    }
  };
}

function toSafeDownloadError(error: unknown): SafeDownloadError {
  if (error instanceof SafeDownloadError) return error;
  if (error instanceof RedirectLimitError) {
    return new SafeDownloadError('TOO_MANY_REDIRECTS', error.message);
  }
  if (error instanceof RedirectLocationError) {
    return new SafeDownloadError('ORIGIN_STATUS', error.message);
  }
  const code = (error as { code?: string } | null)?.code;
  return new SafeDownloadError('NETWORK', `falha de rede${code ? ` (${code})` : ''}`);
}

const tooLargeMessage = (maxBytes: number): string =>
  `Imagem excede o limite de ${Math.round(maxBytes / (1024 * 1024))}MB`;

async function fetchBody(url: string, options: DownloadImageOptions, signal: AbortSignal) {
  const maxBytes = options.maxBytes ?? DOWNLOAD_MAX_BYTES;
  const response = await fetchFollowingRedirects(url, {
    fetch: options.fetch ?? createPinnedFetch(),
    signal,
    maxRedirects: options.maxRedirects ?? DOWNLOAD_MAX_REDIRECTS,
    checkUrl: checkUrlOf(options.allowUrl),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeDownloadError(
      'ORIGIN_STATUS',
      `Falha ao baixar imagem: status ${response.status}`,
    );
  }
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeDownloadError('TOO_LARGE', tooLargeMessage(maxBytes));
  }
  const buffer = await readBodyUpTo(response, maxBytes);
  if (buffer === null) throw new SafeDownloadError('TOO_LARGE', tooLargeMessage(maxBytes));
  return buffer;
}

async function download(url: string, options: DownloadImageOptions, signal: AbortSignal) {
  const buffer = await fetchBody(url, options, signal);
  const image = await readImage(buffer);
  if (!image) throw new SafeDownloadError('NOT_AN_IMAGE', 'o conteúdo não é uma imagem aceita');
  return { buffer, ...image, ...FORMAT_FILES[image.format] };
}

/**
 * Baixa uma foto de fora com as regras de `safe-image-download`: só http(s) sem credenciais, cada endereço conferido antes de
 * conectar (e a conexão presa ao endereço conferido), até 3 redirecionamentos conferidos a cada salto, 10 MB, 30 s no total
 * e conteúdo lido como JPEG, PNG, WebP ou GIF que decodifica. Qualquer recusa ou falha lança `SafeDownloadError` com o
 * motivo; nada é gravado.
 */
export async function downloadImageSafely(
  url: string,
  options: DownloadImageOptions = {},
): Promise<DownloadedImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  // O prazo vale mesmo onde nada escuta o `signal` (a resolução do nome): o aborto rejeita a corrida.
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new SafeDownloadError('TIMEOUT', 'prazo do download esgotado')),
      { once: true },
    );
  });
  expired.catch(() => undefined);
  try {
    return await Promise.race([download(url, options, controller.signal), expired]);
  } catch (error) {
    throw toSafeDownloadError(error);
  } finally {
    clearTimeout(timer);
  }
}
