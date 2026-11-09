import { createHash } from 'crypto';
import * as sharp from 'sharp';
import { cleanRequest } from '../domain/scene-clean-text';
import { REFERENCE_LIMITS, ReferenceOrigin } from '../domain/scene-reference.types';
import { referenceInvalid } from '../scene.errors';
import { REFERENCE_TEXTS } from '../scene-texts';

type UploadedFile = Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'size' | 'originalname'>;

/** O encarte conferido: a origem (sem guardar o original) e a cópia reduzida que vai aos modelos. */
export interface InspectedReference {
  origin: Omit<ReferenceOrigin, 'uploadedByUserId' | 'uploadedAt'>;
  reduced: { buffer: Buffer; width: number; height: number };
}

const FORMATS: Readonly<Record<string, ReferenceOrigin['mimeType']>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
};
const MIME_TYPES = Object.values(FORMATS);

/** Só o nome do arquivo, sem pasta nem caracteres de controle, em até 120 caracteres. */
const fileNameOf = (name: string | undefined): string =>
  cleanRequest((name ?? 'encarte').split(/[\\/]/).pop() ?? '').slice(0, 120) || 'encarte';

/** Lado da imagem depois da rotação EXIF (orientações 5 a 8 giram 90 graus). */
function orientedSize(meta: sharp.Metadata): { width: number; height: number } {
  const turned = (meta.orientation ?? 1) >= 5;
  const width = meta.width as number;
  const height = meta.height as number;
  return turned ? { width: height, height: width } : { width, height };
}

async function readMetadata(buffer: Buffer): Promise<sharp.Metadata> {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error('sem dimensões');
    return meta;
  } catch {
    throw referenceInvalid(REFERENCE_TEXTS.unreadable);
  }
}

/** A cópia reduzida: EXIF aplicado, fundo branco no PNG com transparência, JPEG de até 1536 px. */
async function reduce(buffer: Buffer): Promise<InspectedReference['reduced']> {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: REFERENCE_LIMITS.reducedEdgePx,
        height: REFERENCE_LIMITS.reducedEdgePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: REFERENCE_LIMITS.reducedQuality })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    throw referenceInvalid(REFERENCE_TEXTS.unreadable);
  }
}

/**
 * PV-R2: JPEG ou PNG de até 20 MB, conferido pelo conteúdo (a extensão e o cabeçalho não bastam), com lado maior de
 * pelo menos 800 px. Nada é gravado antes de passar; o original nunca é guardado (PV-R3).
 */
export async function inspectReference(
  file: UploadedFile | undefined,
): Promise<InspectedReference> {
  if (!file?.buffer?.length) throw referenceInvalid(REFERENCE_TEXTS.missingFile);
  if (file.buffer.length > REFERENCE_LIMITS.maxBytes)
    throw referenceInvalid(REFERENCE_TEXTS.tooBig);
  if (!MIME_TYPES.includes(file.mimetype as ReferenceOrigin['mimeType'])) {
    throw referenceInvalid(REFERENCE_TEXTS.notImage);
  }
  const meta = await readMetadata(file.buffer);
  const mimeType = FORMATS[meta.format ?? ''];
  if (!mimeType) throw referenceInvalid(REFERENCE_TEXTS.notImage);
  const { width, height } = orientedSize(meta);
  if (Math.max(width, height) < REFERENCE_LIMITS.minEdgePx) {
    throw referenceInvalid(REFERENCE_TEXTS.tooSmall);
  }
  return {
    origin: {
      fileName: fileNameOf(file.originalname),
      mimeType,
      bytes: file.buffer.length,
      widthPx: width,
      heightPx: height,
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
    },
    reduced: await reduce(file.buffer),
  };
}
