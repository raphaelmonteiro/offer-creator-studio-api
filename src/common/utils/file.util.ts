import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';

export function generateFileName(originalName: string): string {
  const ext = extname(originalName);
  const uniqueName = `${uuidv4()}${ext}`;
  return uniqueName;
}

export function getFileMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

export function isValidImageFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
}

export function isValidFontFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return ['.ttf', '.otf', '.woff', '.woff2'].includes(ext);
}
