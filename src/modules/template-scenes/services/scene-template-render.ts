import * as sharp from 'sharp';
import { SceneFormatSpec } from '../domain/scene-formats';
import { sectionBands } from '../domain/scene-template-config';
import { SceneElement } from '../domain/scene.types';

const JPEG_QUALITY = 92;
const THUMBNAIL_EDGE = 512;
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** Elemento achatado: o PNG transparente do asset e a camada que diz onde ele fica. */
export interface FlattenOverlay {
  element: SceneElement;
  buffer: Buffer;
}

export interface TemplateImageBuffers {
  full: Buffer;
  header: Buffer;
  footer: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Parte da caixa que cai dentro da imagem; `null` se ficou toda de fora. `crop` é relativo à caixa. */
export function clipToCanvas(
  box: Box,
  canvas: { width: number; height: number },
): { left: number; top: number; crop: Box | null } | null {
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(canvas.width, box.left + box.width);
  const bottom = Math.min(canvas.height, box.top + box.height);
  if (right <= left || bottom <= top) return null;
  const inside =
    left === box.left &&
    top === box.top &&
    right - left === box.width &&
    bottom - top === box.height;
  return {
    left,
    top,
    crop: inside
      ? null
      : { left: left - box.left, top: top - box.top, width: right - left, height: bottom - top },
  };
}

async function overlayComposite(
  overlay: FlattenOverlay,
  canvas: { width: number; height: number },
): Promise<sharp.OverlayOptions | null> {
  const { element } = overlay;
  const width = Math.max(1, Math.round(element.w * canvas.width));
  const height = Math.max(1, Math.round(width / element.aspect));
  // `contain`, como a prévia da cena (`object-contain`), e a rotação em volta do centro (CSS `rotate`).
  const { data, info } = await sharp(overlay.buffer)
    .resize({ width, height, fit: 'contain', background: TRANSPARENT })
    .ensureAlpha()
    .rotate(element.rotation || 0, { background: TRANSPARENT })
    .png()
    .toBuffer({ resolveWithObject: true });
  const clip = clipToCanvas(
    {
      left: Math.round(element.x * canvas.width - info.width / 2),
      top: Math.round(element.y * canvas.height - info.height / 2),
      width: info.width,
      height: info.height,
    },
    canvas,
  );
  if (!clip) return null;
  const input = clip.crop ? await sharp(data).extract(clip.crop).png().toBuffer() : data;
  return { input, left: clip.left, top: clip.top };
}

const jpeg = (image: sharp.Sharp): Promise<Buffer> =>
  image.jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' }).toBuffer();

/**
 * Achata a master com os elementos `generated` (em ordem de `z`), corta o cabeçalho e o rodapé nas alturas das
 * zonas e gera a miniatura, tudo em JPEG (PV-3, PV-4). Logo e texto não entram. Não chama provedor.
 */
export async function renderTemplateImages(input: {
  master: Buffer;
  overlays: FlattenOverlay[];
  format: SceneFormatSpec;
}): Promise<TemplateImageBuffers> {
  const meta = await sharp(input.master).metadata();
  const canvas = { width: meta.width as number, height: meta.height as number };
  const ordered = [...input.overlays].sort((a, b) => a.element.z - b.element.z);
  const composites: sharp.OverlayOptions[] = [];
  for (const overlay of ordered) {
    const composite = await overlayComposite(overlay, canvas);
    if (composite) composites.push(composite);
  }
  const flat = await sharp(input.master)
    .flatten({ background: '#ffffff' })
    .composite(composites)
    .png()
    .toBuffer();
  const slice = (top: number, height: number): sharp.Sharp =>
    sharp(flat).extract({ left: 0, top, width: canvas.width, height });
  const { headerPx, footerPx } = sectionBands(input.format, canvas.height);
  return {
    full: await jpeg(sharp(flat)),
    header: await jpeg(slice(0, headerPx)),
    footer: await jpeg(slice(canvas.height - footerPx, footerPx)),
    thumbnail: await sharp(flat)
      .resize({
        width: THUMBNAIL_EDGE,
        height: THUMBNAIL_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer(),
    ...canvas,
  };
}
