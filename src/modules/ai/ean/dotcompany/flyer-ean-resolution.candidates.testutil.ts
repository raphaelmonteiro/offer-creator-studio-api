import { productAliasKey } from '../../../gallery/product-alias';

/** A Galeria de teste das candidatas do Encarte Pro (só testes): fotos em memória e a consulta SQL que as lê. */

export const PICCIN = '9a1c5f0e-3b7d-4a62-8c14-5e2f7d9b0a31';
export const OTHER_CLIENT = '3d8e1a77-6c40-4b9f-a2d5-0f1e8c7b6a54';
/** GTIN com dígito verificador certo (o `7896000000017` dos exemplos da spec fecha errado em `isValidGtin`). */
export const BEER_EAN = '7896000000019';
/** Mesmo prefixo, dígito verificador errado. */
export const BAD_EAN = '7896000000018';

export interface FakePhoto {
  id: string;
  ean?: string;
  eanSource?: string;
  aliases?: Array<{ name: string; chosenAt: string }>;
  /** Clientes para quem a foto é preferida (`client_preferred_images`). */
  preferredBy?: string[];
}

const base = (photo: FakePhoto) => ({
  id: photo.id,
  url: `http://localhost:3101/uploads/gallery/${photo.id}.png`,
  thumbnailUrl: null,
  filename: `${photo.id}.png`,
});

const preferredFor = (photo: FakePhoto, clientId: string | null) =>
  clientId !== null && (photo.preferredBy ?? []).includes(clientId);

/** As linhas que `galleryByAlias` lê: uma por nome da foto cuja chave está em `keys`. */
function aliasRows(photos: FakePhoto[], keys: string[], clientId: string | null) {
  return photos.flatMap((photo) =>
    (photo.aliases ?? [])
      .filter((alias) => keys.includes(productAliasKey(alias.name)))
      .map((alias) => ({
        ...base(photo),
        key: productAliasKey(alias.name),
        chosenAt: alias.chosenAt,
        preferred: preferredFor(photo, clientId),
      })),
  );
}

/** As linhas que `galleryByEan` lê: as fotos com um dos EANs pedidos (todas as variantes), na ordem da Galeria. */
function eanRows(photos: FakePhoto[], eans: string[], clientId: string | null) {
  return photos
    .filter((photo) => photo.ean && eans.includes(photo.ean))
    .map((photo) => ({
      ...base(photo),
      ean: photo.ean,
      source: photo.eanSource ?? 'manual',
      preferred: preferredFor(photo, clientId),
    }));
}

/** O `dataSource.query` da Galeria de teste: responde às duas consultas do serviço e a mais nenhuma. */
export function fakeGalleryQuery(photos: FakePhoto[]) {
  return jest.fn(async (sql: string, params: unknown[] = []) => {
    const clientId = (params[1] as string | null) ?? null;
    if (sql.includes('jsonb_array_elements'))
      return aliasRows(photos, params[0] as string[], clientId);
    if (sql.includes("metadata->>'ean'")) return eanRows(photos, params[0] as string[], clientId);
    return [];
  });
}

/** Uma candidata pontuada pela busca por nome. */
export function scoredOf(imageId: string, score: number, reasons: string[] = []) {
  return {
    imageId,
    url: `http://localhost:3101/uploads/gallery/${imageId}.png`,
    thumbnailUrl: null,
    filename: `${imageId}.png`,
    folderName: null,
    score,
    reasons,
    isClientPreferred: false,
  };
}
