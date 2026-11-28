import { z } from 'zod';
import type { PhotoSearchResult } from './flyer-pro-photo-search.port';

/** Texto que, se vier fora da forma, vale ausente (a Serper não o garante, A-30). */
const optionalText = z.string().min(1).optional().catch(undefined);
/** Lado em pixels: só inteiro positivo vale; o resto vale ausente. */
const optionalSide = z.number().int().positive().optional().catch(undefined);

/** Só o `imageUrl` é obrigatório; o resto é lido se vier na forma certa (A4b do design: `title` e tamanho a confirmar na passada real). */
const imageSchema = z.object({
  imageUrl: z.string().min(1),
  thumbnailUrl: optionalText,
  domain: optionalText,
  title: z.string().optional().catch(undefined),
  imageWidth: optionalSide,
  imageHeight: optionalSide,
});

const searchSchema = z.object({ images: z.array(z.unknown()) });

const hostOf = (imageUrl: string): string => {
  try {
    return new URL(imageUrl).hostname;
  } catch {
    return '';
  }
};

type SerperImage = z.infer<typeof imageSchema>;

/** Largura e altura só valem juntas: sem uma das duas, o tamanho é desconhecido (A-25). */
function sizeOf(image: SerperImage): Pick<PhotoSearchResult, 'width' | 'height'> {
  const { imageWidth, imageHeight } = image;
  return imageWidth && imageHeight
    ? { width: imageWidth, height: imageHeight }
    : { width: null, height: null };
}

const toResult = (image: SerperImage): PhotoSearchResult => ({
  imageUrl: image.imageUrl,
  thumbnailUrl: image.thumbnailUrl ?? null,
  domain: image.domain ?? hostOf(image.imageUrl),
  title: image.title ?? '',
  ...sizeOf(image),
});

/**
 * Os resultados de uma resposta de `/images`: o item sem `imageUrl` sai (um item ruim não derruba a página). `null` quando a
 * resposta não tem a lista `images` (fora da forma: o provedor responde `PROVIDER_ERROR`).
 */
export function parseSerperImages(raw: unknown): PhotoSearchResult[] | null {
  const page = searchSchema.safeParse(raw);
  if (!page.success) return null;
  return page.data.images.flatMap((item) => {
    const image = imageSchema.safeParse(item);
    return image.success ? [toResult(image.data)] : [];
  });
}

const resolveSchema = z.object({
  images: z.array(z.object({ imageUrl: z.string().min(1) })).min(1),
  retryAfter: z.unknown(),
});

/**
 * O endereço resolvido de uma resposta de `/resolve`, **a única leitura da forma dela** (D-orq-251: a passada real confirma
 * ou troca esta linha): `images[0].imageUrl`. `null` quando a resposta não tem essa forma ou quando traz `retryAfter` (o
 * link ainda não está pronto: esperar não ajuda, "Retrying sooner won't help").
 */
export function resolvedUrlOf(raw: unknown): string | null {
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.retryAfter !== undefined && parsed.data.retryAfter !== null) return null;
  return parsed.data.images[0].imageUrl;
}
