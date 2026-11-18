import type { SaveResponseFields } from '../domain/flyer-pro-save-rules';
import type {
  FlyerProFormat,
  FlyerProTemplateSnapshot,
  FlyerProTemplateStatus,
} from '../domain/flyer-pro.types';
import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { FlyerProItemView, toItemView } from './flyer-pro-document.view';

/** Falha ao registrar a escolha da foto na Galeria (change 27); a gravação do encarte não é desfeita. */
export interface FlyerProLinkWarning {
  itemId: string;
  code: 'GALLERY_IMAGE_NOT_FOUND' | 'GALLERY_LINK_FAILED';
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
}

export interface SaveViewInput {
  /** O encarte como ficou (ou como está, no reenvio e na regravação descartada). */
  document: FlyerProDocument;
  replayed: boolean;
  applied: boolean;
  items?: FlyerProItem[];
  deletedItemIds?: string[];
  fields: SaveResponseFields;
  /** O estado da cópia, calculado na hora; só quando `fields.template`. */
  templateStatus?: FlyerProTemplateStatus;
  /** Os itens cujo registro da foto na Galeria falhou; vazio sem falha e no reenvio. */
  linkWarnings?: FlyerProLinkWarning[];
}

function templateFieldsOf({ document, fields, templateStatus }: SaveViewInput) {
  if (!fields.template) return {};
  return {
    format: document.format,
    templateSnapshot: document.templateSnapshot,
    templateStatus,
  };
}

export function toSaveView(input: SaveViewInput): FlyerProSaveView {
  const { document, replayed, applied, fields, linkWarnings = [] } = input;
  const { items = [], deletedItemIds = [] } = input;
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
    linkWarnings,
  };
}
