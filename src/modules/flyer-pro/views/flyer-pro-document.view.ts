import { isValidGtin } from '../../ai/ean/gtin.util';
import type {
  FlyerProFormat,
  FlyerProTemplateSnapshot,
  FlyerProTemplateStatus,
} from '../domain/flyer-pro.types';
import type { FlyerProDocument, FlyerProSlice } from '../entities/flyer-pro-document.entity';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import type { FlyerProJobView } from './flyer-pro-job.view';

/**
 * As respostas do módulo montadas a partir das linhas: nada da entidade sai sem passar por aqui (`creationKey` e
 * `deletedAt` ficam de fora). Datas em ISO 8601 UTC; nulo e ausência tratados à mão (`strictNullChecks` desligado).
 */

const iso = (date: Date | string): string => new Date(date).toISOString();

export interface FlyerProItemView {
  id: string;
  position: number;
  name: string;
  sourceName: string | null;
  price: Record<string, unknown>;
  unit: string;
  category: string | null;
  categorySource: string | null;
  categoryReview: Record<string, unknown> | null;
  isAlcoholic: boolean;
  ean: string | null;
  /** `null` sem EAN; `true` ou `false` pelo dígito verificador, conferido na leitura. */
  eanValid: boolean | null;
  galleryImageId: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  imageOrigin: string | null;
  imageStatus: string;
  imageReview: Record<string, unknown> | null;
  spellReview: Record<string, unknown> | null;
  imported: Record<string, unknown> | null;
  /** A importação que criou o item; `null` no item incluído à mão. */
  importId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlyerProDocumentView {
  id: string;
  name: string;
  clientId: string;
  sceneId: string;
  format: FlyerProFormat;
  pageCount: number;
  pagesFrozen: boolean;
  step: string;
  ui: Record<string, unknown>;
  schemaVersion: number;
  engineVersion: number;
  revision: number;
  lastMutationId: string | null;
  layoutDigest: string | null;
  renderDigest: string | null;
  layoutSnapshot: Record<string, unknown> | null;
  templateSnapshot: FlyerProTemplateSnapshot;
  templateStatus: FlyerProTemplateStatus;
  slices: {
    frame: FlyerProSlice;
    structure: FlyerProSlice;
    card: FlyerProSlice;
    assembly: FlyerProSlice;
    exportPrefs: FlyerProSlice;
  };
  items: FlyerProItemView[];
  /** O maior `updatedAt` dos itens (ou o `createdAt` do encarte sem itens), com microssegundos. */
  itemsCursor: string;
  /** O job de enriquecimento: o ativo ou, sem ativo, o mais recente; `null` se o encarte nunca teve job. */
  enrichment: FlyerProJobView | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A linha que a lista lê (colunas leves, nome do cliente, nome de quem gravou por último e a contagem de itens). */
export interface FlyerProDocumentListRow {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  format: FlyerProFormat;
  pageCount: number;
  step: string;
  itemCount: number;
  revision: number;
  updatedByUserId: string | null;
  updatedByName: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type FlyerProDocumentListItemView = Omit<
  FlyerProDocumentListRow,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

type ItemImageView = Pick<
  FlyerProItemView,
  'galleryImageId' | 'imageUrl' | 'imageWidth' | 'imageHeight' | 'imageOrigin' | 'imageReview'
>;

function itemImageOf(item: FlyerProItem): ItemImageView {
  return {
    galleryImageId: item.galleryImageId ?? null,
    imageUrl: item.imageUrl ?? null,
    imageWidth: item.imageWidth ?? null,
    imageHeight: item.imageHeight ?? null,
    imageOrigin: item.imageOrigin ?? null,
    imageReview: item.imageReview ?? null,
  };
}

export function toItemView(item: FlyerProItem): FlyerProItemView {
  return {
    id: item.id,
    position: item.position,
    name: item.name,
    sourceName: item.sourceName ?? null,
    price: item.price,
    unit: item.unit,
    category: item.category ?? null,
    categorySource: item.categorySource ?? null,
    categoryReview: item.categoryReview ?? null,
    isAlcoholic: item.isAlcoholic,
    ean: item.ean ?? null,
    eanValid: item.ean ? isValidGtin(item.ean) : null,
    ...itemImageOf(item),
    imageStatus: item.imageStatus,
    spellReview: item.spellReview ?? null,
    imported: item.imported ?? null,
    importId: item.importId ?? null,
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
  };
}

export interface DocumentViewInput {
  document: FlyerProDocument;
  items: FlyerProItem[];
  itemsCursor: string;
  templateStatus: FlyerProTemplateStatus;
  /** O job que o encarte mostra, já na forma de leitura; `null` se nunca houve job. */
  enrichment: FlyerProJobView | null;
}

function slicesOf(document: FlyerProDocument): FlyerProDocumentView['slices'] {
  return {
    frame: document.frame ?? {},
    structure: document.structure ?? {},
    card: document.card ?? {},
    assembly: document.assembly ?? {},
    exportPrefs: document.exportPrefs ?? {},
  };
}

export function toDocumentView({
  document,
  items,
  itemsCursor,
  templateStatus,
  enrichment,
}: DocumentViewInput): FlyerProDocumentView {
  return {
    id: document.id,
    name: document.name,
    clientId: document.clientId,
    sceneId: document.sceneId,
    format: document.format,
    pageCount: document.pageCount,
    pagesFrozen: document.pagesFrozen,
    step: document.step,
    ui: document.ui ?? {},
    schemaVersion: document.schemaVersion,
    engineVersion: document.engineVersion,
    revision: document.revision,
    lastMutationId: document.lastMutationId ?? null,
    layoutDigest: document.layoutDigest ?? null,
    renderDigest: document.renderDigest ?? null,
    layoutSnapshot: document.layoutSnapshot ?? null,
    templateSnapshot: document.templateSnapshot,
    templateStatus,
    slices: slicesOf(document),
    items: items.map(toItemView),
    itemsCursor,
    enrichment,
    createdByUserId: document.createdByUserId ?? null,
    updatedByUserId: document.updatedByUserId ?? null,
    createdAt: iso(document.createdAt),
    updatedAt: iso(document.updatedAt),
  };
}

export function toListItemView(row: FlyerProDocumentListRow): FlyerProDocumentListItemView {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    clientName: row.clientName,
    format: row.format,
    pageCount: row.pageCount,
    step: row.step,
    itemCount: row.itemCount,
    revision: row.revision,
    updatedByUserId: row.updatedByUserId ?? null,
    updatedByName: row.updatedByName ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
