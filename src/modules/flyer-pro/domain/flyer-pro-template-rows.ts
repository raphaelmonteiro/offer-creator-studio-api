import type { FlyerProTemplateElement } from './flyer-pro.types';

/**
 * As linhas que a lista e o montador leem das tabelas das cenas, já reduzidas: a `configuration` do template nunca
 * entra aqui inteira (só `source`, `header`, `footer` e a URL do fundo). Os tipos são deste módulo e não importam as
 * entidades nem o domínio de `template-scenes` (A-01-16).
 */
export interface SceneRow {
  id: string;
  name: string;
  formatId: string;
  layout: string;
  artHeightCm: number;
  revision: number;
  updatedAt: Date;
  approvedTemplateId: string | null;
  deletedAt: Date | null;
}

export interface FaceRow {
  sceneId: string;
  index: number;
  key: string;
  label: string | null;
  widthPx: number;
  heightPx: number;
  templateId: string | null;
}

/** `configuration.source` do template de cena. */
export interface TemplateSourceRow {
  kind?: string;
  pictorialKey: string;
  fingerprint: string;
  syncedAt: string;
}

/** `configuration.header` ou `.footer`: a seção que a projeção grava. */
export interface TemplateSectionRow {
  widthCm: number;
  heightCm: number;
  background?: { imageUrl?: string } | null;
  elements?: FlyerProTemplateElement[] | null;
}

export interface TemplateRow {
  id: string;
  thumbnailUrl: string | null;
  /** `configuration.bodyBackground.imageUrl`. */
  artUrl: string | null;
  source: TemplateSourceRow | null;
  header: TemplateSectionRow | null;
  footer: TemplateSectionRow | null;
}
