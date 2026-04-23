import { UploadsService } from '../../uploads/uploads.service';
import { fetchWithTimeout } from './fetch-with-timeout.util';

export type OpenAiImageSize = '1024x1024' | '1024x1536' | '1536x1024';

export interface GeneratedImageData {
  b64_json?: string;
  url?: string;
}

export interface MaterializedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  sourceType: 'base64' | 'data-url' | 'url';
}

export interface UploadGeneratedAssetOptions {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  folder: string;
  uploadsService: UploadsService;
}

export interface SelectImageSizeOptions {
  portraitMaxRatio?: number;
  landscapeMinRatio?: number;
}

export function selectImageSizeByAspectRatio(
  width: number,
  height: number,
  options?: SelectImageSizeOptions,
): OpenAiImageSize {
  const ratio = width / height;

  if (options?.portraitMaxRatio !== undefined && ratio < options.portraitMaxRatio) {
    return '1024x1536';
  }

  if (options?.landscapeMinRatio !== undefined && ratio > options.landscapeMinRatio) {
    return '1536x1024';
  }

  if (options?.portraitMaxRatio !== undefined || options?.landscapeMinRatio !== undefined) {
    return '1024x1024';
  }

  const candidates: Array<{ size: OpenAiImageSize; ratio: number }> = [
    { size: '1024x1536', ratio: 1024 / 1536 },
    { size: '1024x1024', ratio: 1 },
    { size: '1536x1024', ratio: 1536 / 1024 },
  ];

  return candidates.reduce((best, candidate) =>
    Math.abs(candidate.ratio - ratio) < Math.abs(best.ratio - ratio) ? candidate : best,
  ).size;
}

export async function materializeGeneratedImage(
  image: GeneratedImageData | string | null | undefined,
  fallbackMimeType = 'image/png',
): Promise<MaterializedImage> {
  if (!image) {
    throw new Error('Imagem gerada vazia');
  }

  if (typeof image === 'string') {
    if (image.startsWith('data:')) {
      return materializeDataUrl(image, fallbackMimeType);
    }
    return materializeRemoteImage(image, fallbackMimeType);
  }

  if (image.b64_json) {
    return {
      buffer: Buffer.from(image.b64_json, 'base64'),
      mimeType: fallbackMimeType,
      extension: extensionFromMimeType(fallbackMimeType),
      sourceType: 'base64',
    };
  }

  if (image.url) {
    return materializeRemoteImage(image.url, fallbackMimeType);
  }

  throw new Error('Imagem gerada sem b64_json ou url');
}

export async function uploadGeneratedAsset(options: UploadGeneratedAssetOptions) {
  const fakeFile = {
    buffer: options.buffer,
    originalname: options.filename,
    size: options.buffer.length,
    mimetype: options.mimeType,
    fieldname: 'file',
    encoding: '7bit',
  } as Express.Multer.File;

  return options.uploadsService.uploadFile(fakeFile, options.folder);
}

export function extensionFromMimeType(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[base] ?? '.png';
}

async function materializeRemoteImage(
  url: string,
  fallbackMimeType: string,
): Promise<MaterializedImage> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar imagem gerada: ${response.status}`);
  }

  const mimeType = response.headers.get('content-type') || fallbackMimeType;
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType,
    extension: extensionFromMimeType(mimeType),
    sourceType: 'url',
  };
}

function materializeDataUrl(dataUrl: string, fallbackMimeType: string): MaterializedImage {
  const [header, b64data] = dataUrl.split(',');
  const mimeType = header?.split(':')[1]?.split(';')[0] || fallbackMimeType;

  return {
    buffer: Buffer.from(b64data, 'base64'),
    mimeType,
    extension: extensionFromMimeType(mimeType),
    sourceType: 'data-url',
  };
}
