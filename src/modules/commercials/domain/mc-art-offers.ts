import { createHash } from 'crypto';
import { McProjectFormat } from './mc-types';

/**
 * Ponte arte → projeto (change video-formatos-personagem, design D9), parte
 * PURA: lê as ofertas de uma página de arte do Chroma, aplica as regras de
 * seleção por formato e calcula o hash do snapshot congelado no projeto.
 *
 * Duas fontes de dados, reconhecidas pela FORMA do jsonb (a tabela de origem
 * é problema do service):
 * - `flyers.configuration` (encarte legado): `products[]` no raiz (uma página)
 *   ou `pages[].configuration.products[]` (multipágina), cada produto no
 *   formato do editor legado `{id, catalogId|productId, name, price,
 *   originalPrice, unit, imageUrl}` com preços NUMÉRICOS;
 * - `flyer_builder_v2_documents.document` (encarte V2 e arte social):
 *   `pages[].elements[]` filtrados por `type === 'product'`, oferta em
 *   `productData` `{id, catalogId, name, price, originalPrice, unit, imageUrl}`.
 *
 * Sem Nest/TypeORM: erros saem como `McArtOffersError` com `code` e o service
 * traduz para 422 (regra de negócio, convenção D13).
 */

/** Oferta extraída da página, normalizada (preços já formatados em pt-BR). */
export interface McArtOffer {
  /** Id ESTÁVEL dentro da página (id do produto na arte); é o que a seleção referencia. */
  id: string;
  catalogId: string | null;
  name: string;
  /** "12,90" — sem o "R$", como `ProjectProductDto.price`. */
  price: string;
  originalPrice: string | null;
  unit: string | null;
  imageUrl: string | null;
}

export type McArtOffersErrorCode =
  | 'PAGE_NOT_FOUND'
  | 'SOURCE_WITHOUT_OFFERS'
  | 'OFFER_NOT_FOUND'
  | 'OFFER_IMAGE_REQUIRED'
  | 'OFFER_SELECTION_INVALID';

export class McArtOffersError extends Error {
  constructor(
    readonly code: McArtOffersErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'McArtOffersError';
  }
}

/** Limites de seleção por formato (spec video-project-from-art, "Escolha de ofertas"). */
export const MC_CAROUSEL_OFFERS_MIN = 3;
export const MC_CAROUSEL_OFFERS_MAX = 6;
export const MC_TALKING_ART_OFFERS_MAX = 3;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null;

/** "9,99" a partir de número (9.99) ou de string já formatada ("R$ 9,99" → "9,99"). */
export function formatOfferPrice(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value.toFixed(2).replace('.', ',');
  }
  if (typeof value === 'string') {
    const trimmed = value
      .trim()
      .replace(/^R\$\s*/i, '')
      .trim();
    if (!trimmed) return null;
    // "9.99" (ponto decimal, sem milhar) vira "9,99"; o resto fica como veio.
    if (/^\d+\.\d{1,2}$/.test(trimmed)) return Number(trimmed).toFixed(2).replace('.', ',');
    return trimmed;
  }
  return null;
}

const stringOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Ids repetidos na mesma página ganham sufixo posicional — a seleção precisa de id único. */
function uniqueId(base: string, index: number, seen: Set<string>): string {
  let id = base || `offer-${index}`;
  if (seen.has(id)) id = `${id}#${index}`;
  seen.add(id);
  return id;
}

function offerFromProductData(raw: Dict, index: number, seen: Set<string>): McArtOffer | null {
  const name = stringOrNull(raw.name);
  const price = formatOfferPrice(raw.price);
  if (!name || !price) return null;
  const base = stringOrNull(raw.id) ?? '';
  return {
    id: uniqueId(base, index, seen),
    catalogId: stringOrNull(raw.catalogId) ?? stringOrNull(raw.productId),
    name,
    price,
    originalPrice: formatOfferPrice(raw.originalPrice),
    unit: stringOrNull(raw.unit),
    imageUrl: stringOrNull(raw.imageUrl),
  };
}

/** `document.pages[pageIndex].elements[]` com `type === 'product'` → `productData` (V2 e social). */
export function extractOffersFromV2Document(document: unknown, pageIndex: number): McArtOffer[] {
  const pages = isDict(document) && Array.isArray(document.pages) ? document.pages : null;
  if (!pages) throw new McArtOffersError('SOURCE_WITHOUT_OFFERS', 'Documento V2 sem páginas.');
  const page = pages[pageIndex];
  if (!isDict(page)) {
    throw new McArtOffersError(
      'PAGE_NOT_FOUND',
      `A arte tem ${pages.length} página(s); a página ${pageIndex} não existe.`,
      { pageIndex, pageCount: pages.length },
    );
  }
  const elements = Array.isArray(page.elements) ? page.elements : [];
  const seen = new Set<string>();
  const offers: McArtOffer[] = [];
  elements.forEach((element, index) => {
    if (!isDict(element) || element.type !== 'product' || element.visible === false) return;
    if (!isDict(element.productData)) return;
    const offer = offerFromProductData(element.productData, index, seen);
    if (offer) offers.push(offer);
  });
  return offers;
}

/** `configuration.products[]` (legado, uma página) ou `pages[pageIndex].configuration.products[]`. */
export function extractOffersFromFlyerConfiguration(
  configuration: unknown,
  pageIndex: number,
): McArtOffer[] {
  if (!isDict(configuration)) {
    throw new McArtOffersError('SOURCE_WITHOUT_OFFERS', 'Configuração do encarte vazia.');
  }
  let products: unknown[];
  if (Array.isArray(configuration.pages)) {
    const page = configuration.pages[pageIndex];
    if (!isDict(page)) {
      throw new McArtOffersError(
        'PAGE_NOT_FOUND',
        `O encarte tem ${configuration.pages.length} página(s); a página ${pageIndex} não existe.`,
        { pageIndex, pageCount: configuration.pages.length },
      );
    }
    const pageConfig = isDict(page.configuration) ? page.configuration : page;
    products = Array.isArray(pageConfig.products) ? pageConfig.products : [];
  } else {
    if (pageIndex !== 0) {
      throw new McArtOffersError(
        'PAGE_NOT_FOUND',
        `O encarte tem 1 página; a página ${pageIndex} não existe.`,
        { pageIndex, pageCount: 1 },
      );
    }
    products = Array.isArray(configuration.products) ? configuration.products : [];
  }
  const seen = new Set<string>();
  const offers: McArtOffer[] = [];
  products.forEach((raw, index) => {
    if (!isDict(raw)) return;
    const offer = offerFromProductData(raw, index, seen);
    if (offer) offers.push(offer);
  });
  return offers;
}

/** Documento V2 tem `pages[].elements`; o resto é tratado como configuração de encarte. */
export function isV2DocumentShape(payload: unknown): boolean {
  if (!isDict(payload) || !Array.isArray(payload.pages)) return false;
  if (payload.builder === 'flyer-builder-v2') return true;
  return payload.pages.some((page) => isDict(page) && Array.isArray(page.elements));
}

/** Despacho pela forma do jsonb — a tabela de origem não importa aqui. */
export function extractOffers(payload: unknown, pageIndex: number): McArtOffer[] {
  return isV2DocumentShape(payload)
    ? extractOffersFromV2Document(payload, pageIndex)
    : extractOffersFromFlyerConfiguration(payload, pageIndex);
}

/** Nº de páginas da arte (1 para a configuração legada de página única). */
export function sourcePageCount(payload: unknown): number {
  if (isDict(payload) && Array.isArray(payload.pages)) return payload.pages.length;
  return 1;
}

/** JSON canônico (chaves ordenadas, nulls explícitos) — a ordem das ofertas CONTA. */
export function canonicalOffersJson(offers: McArtOffer[]): string {
  return JSON.stringify(
    offers.map((o) => ({
      catalogId: o.catalogId,
      id: o.id,
      imageUrl: o.imageUrl,
      name: o.name,
      originalPrice: o.originalPrice,
      price: o.price,
      unit: o.unit,
    })),
  );
}

/**
 * Hash do snapshot (design D9): sha256 das ofertas extraídas (canônicas) +
 * o asset da arte. Reextrair a origem atual e comparar diz se "a arte de
 * origem mudou" — qualquer preço, nome, imagem, unidade ou oferta a mais/
 * menos troca o hash; o asset entra para amarrar o snapshot à arte enviada.
 */
export function computeSnapshotHash(offers: McArtOffer[], artAssetId: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ artAssetId, offers: canonicalOffersJson(offers) }))
    .digest('hex');
}

export interface McOfferSelectionItem {
  id: string;
  /** Imagem escolhida pelo usuário (catálogo/galeria) para uma oferta sem foto na arte. */
  imageUrl?: string | null;
}

/**
 * Seleção de ofertas por formato (spec "Escolha de ofertas para o vídeo"):
 * - `offer_carousel`: 3 a 6 ofertas, NA ORDEM enviada, cada uma com imagem
 *   (da arte, do catálogo via `resolveImage`, ou `imageUrl` da seleção);
 *   sem imagem → OFFER_IMAGE_REQUIRED listando as ofertas pendentes;
 * - `talking_art`: até 3 ofertas citadas, opcionais; sem seleção, as
 *   primeiras da página (o teto do snapshot é o de `MC_MAX_SEAL_PRODUCTS`).
 * Os limites numéricos já chegam validados pelo DTO (400); aqui ficam como
 * guarda de regra (422 OFFER_SELECTION_INVALID) para chamadas internas.
 */
export function selectOffers(
  format: McProjectFormat,
  offers: McArtOffer[],
  selection: McOfferSelectionItem[] | undefined,
  resolveImage: (offer: McArtOffer) => string | null = () => null,
): McArtOffer[] {
  const byId = new Map(offers.map((o) => [o.id, o]));
  const chosen = selection ?? [];
  const missing = chosen.filter((s) => !byId.has(s.id)).map((s) => s.id);
  if (missing.length > 0) {
    throw new McArtOffersError(
      'OFFER_NOT_FOUND',
      `Oferta(s) não encontrada(s) nesta página da arte: ${missing.join(', ')}`,
      { offerIds: missing },
    );
  }
  const resolved = chosen.map((s) => {
    const offer = byId.get(s.id) as McArtOffer;
    const override = stringOrNull(s.imageUrl ?? null);
    const imageUrl = override ?? offer.imageUrl ?? resolveImage(offer);
    return { ...offer, imageUrl };
  });

  if (format === 'offer_carousel') {
    if (resolved.length < MC_CAROUSEL_OFFERS_MIN || resolved.length > MC_CAROUSEL_OFFERS_MAX) {
      throw new McArtOffersError(
        'OFFER_SELECTION_INVALID',
        `"Ofertas em sequência" pede de ${MC_CAROUSEL_OFFERS_MIN} a ${MC_CAROUSEL_OFFERS_MAX} ofertas (recebidas: ${resolved.length}).`,
        { min: MC_CAROUSEL_OFFERS_MIN, max: MC_CAROUSEL_OFFERS_MAX, received: resolved.length },
      );
    }
    const withoutImage = resolved.filter((o) => !o.imageUrl);
    if (withoutImage.length > 0) {
      throw new McArtOffersError(
        'OFFER_IMAGE_REQUIRED',
        'Toda oferta de "ofertas em sequência" precisa de imagem. Escolha uma foto do catálogo ' +
          `ou da galeria para: ${withoutImage.map((o) => o.name).join(', ')}`,
        {
          offers: withoutImage.map((o) => ({ id: o.id, name: o.name, catalogId: o.catalogId })),
        },
      );
    }
    return resolved;
  }

  if (resolved.length > MC_TALKING_ART_OFFERS_MAX) {
    throw new McArtOffersError(
      'OFFER_SELECTION_INVALID',
      `"Arte que fala" cita no máximo ${MC_TALKING_ART_OFFERS_MAX} ofertas (recebidas: ${resolved.length}).`,
      { max: MC_TALKING_ART_OFFERS_MAX, received: resolved.length },
    );
  }
  if (resolved.length > 0) return resolved;
  // Sem seleção explícita: a arte inteira vai no snapshot (o teto de 6 é
  // aplicado por `resolveProjectOptions`); o diretor do F1 cita até 3 delas.
  return offers.map((o) => ({ ...o, imageUrl: o.imageUrl ?? resolveImage(o) }));
}
