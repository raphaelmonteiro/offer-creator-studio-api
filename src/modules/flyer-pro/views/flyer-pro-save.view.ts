import type { SaveResponseFields } from '../domain/flyer-pro-save-rules';
import type {
  FlyerProFormat,
  FlyerProTemplateSnapshot,
  FlyerProTemplateStatus,
} from '../domain/flyer-pro.types';
import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { FlyerProItemView, toItemView } from './flyer-pro-document.view';
import type { FlyerProJobView } from './flyer-pro-job.view';

/** Falha ao registrar a escolha da foto na Galeria (change 27); a gravação do encarte não é desfeita. */
export interface FlyerProLinkWarning {
  itemId: string;
  code: 'GALLERY_IMAGE_NOT_FOUND' | 'GALLERY_LINK_FAILED';
}

/** O que o `PATCH` com `enrich` responde: se este salvar criou o job e o job que o encarte mostra. */
export interface FlyerProEnrichmentOutcome {
  started: boolean;
  job: FlyerProJobView | null;
}

/** A resposta 200 do `PATCH` (N4): os campos do template só quando o corpo trocou a arte ou o número de páginas. */
export interface FlyerProSaveView {
  id: string;
  revision: number;
  updatedAt: string;
  replayed: boolean;
  applied: boolean;
  pagesFrozen: boolean;
  format?: FlyerProFormat;
  pageCount?: number;
  templateSnapshot?: FlyerProTemplateSnapshot;
  templateStatus?: FlyerProTemplateStatus;
  items: FlyerProItemView[];
  deletedItemIds: string[];
  linkWarnings: FlyerProLinkWarning[];
  /** Só quando o corpo trouxe `enrich`. */
  enrichment?: FlyerProEnrichmentOutcome;
}

export interface SaveViewInput {
  /** O encarte como ficou (ou como está, no reenvio e na regravação descartada). */
  document: FlyerProDocument;
  replayed: boolean;
  applied: boolean;
  items?: FlyerProItem[];
  deletedItemIds?: string[];
  fields: SaveResponseFields;
  /** O resultado do passo do job; só quando o corpo trouxe `enrich`. */
  enrichment?: FlyerProEnrichmentOutcome;
  /** O estado da cópia, calculado na hora; só quando `fields.template`. */
  templateStatus?: FlyerProTemplateStatus;
}

function templateFieldsOf({ document, fields, templateStatus }: SaveViewInput) {
  if (!fields.template) return {};
  return {
    format: document.format,
    templateSnapshot: document.templateSnapshot,
    templateStatus,
  };
}

/** `linkWarnings` é sempre `[]` até a change 27 registrar a escolha da foto na Galeria. */
export function toSaveView(input: SaveViewInput): FlyerProSaveView {
  const { document, replayed, applied, items = [], deletedItemIds = [], fields } = input;
  return {
    id: document.id,
    revision: document.revision,
    updatedAt: new Date(document.updatedAt).toISOString(),
    replayed,
    applied,
    pagesFrozen: document.pagesFrozen,
    ...templateFieldsOf(input),
    ...(fields.pageCount ? { pageCount: document.pageCount } : {}),
    items: items.map(toItemView),
    deletedItemIds,
    linkWarnings: [],
    ...(input.enrichment ? { enrichment: input.enrichment } : {}),
  };
}
