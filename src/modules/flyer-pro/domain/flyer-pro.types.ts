/**
 * Tipos do `templateSnapshot` (a cópia congelada do template de uma cena) e da entrada da lista de templates, como em
 * A1 § 7.1 e A2 N7. O servidor monta a cópia; o cliente nunca a envia. No fim do arquivo, os tipos da exportação (N8).
 */

export type FlyerProFormat = '27x40' | '54x40';
export type FlyerProFold = 'simple' | 'double';
export type FlyerProLayout = 'single' | 'front_back' | 'tabloid';
export type FlyerProFaceKey = 'single' | 'front' | 'back' | 'outer' | 'inner';

/** Zona em % da altura da arte, com 2 casas. Zona que a face não tem: cabeçalho 0 a 0, rodapé 100 a 100. */
export interface FlyerProZone {
  from: number;
  to: number;
}

interface FlyerProElementBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  rotation: number;
}

/** Camada de logo ou de texto do Templates v2, na forma de `templates.configuration.header.elements[]`. */
export type FlyerProTemplateElement =
  | (FlyerProElementBase & { type: 'image'; src: string; alt: string; objectFit: 'contain' })
  | (FlyerProElementBase & {
      type: 'text';
      content: string;
      fontSize: number;
      fontFamily: string;
      fontWeight: 'normal';
      color: string;
      textAlign: 'center';
      lineHeight: number;
    });

/** Faixa de cabeçalho ou de rodapé da face. */
export interface FlyerProTemplateBand {
  /** Fatia da arte (`header.jpg` ou `footer.jpg`). */
  imageUrl: string;
  /** Largura da arte com sangria. */
  widthCm: number;
  heightCm: number;
  elements: FlyerProTemplateElement[];
}

export interface FlyerProTemplateFace {
  key: FlyerProFaceKey;
  index: number;
  /** `Frente`, `Verso`, `Externa`, `Interna`; nulo na face única. */
  label: string | null;
  /** Só auditoria: a linha de `templates` pode ser recriada com outro id. */
  templateId: string;
  /** Imagem achatada da face (`full.jpg`). */
  artUrl: string;
  thumbnailUrl: string | null;
  widthPx: number;
  heightPx: number;
  zones: { header: FlyerProZone; footer: FlyerProZone };
  /** Nulo: a face não tem a zona. */
  header: FlyerProTemplateBand | null;
  footer: FlyerProTemplateBand | null;
  /** Muda só quando a imagem muda. */
  pictorialKey: string;
  /** Muda com imagem, camadas ou nome. */
  fingerprint: string;
  syncedAt: string;
}

export interface FlyerProTemplateSnapshot {
  v: 1;
  sceneId: string;
  name: string;
  format: FlyerProFormat;
  fold: FlyerProFold;
  layout: FlyerProLayout;
  faces: FlyerProTemplateFace[];
  /** Só auditoria: nunca diz se a cena mudou. */
  sceneRevision: number;
  /** ISO 8601 UTC, hora da cópia. */
  capturedAt: string;
}

export type FlyerProUnusableReason = 'FACE_MISSING' | 'LAYOUT_UNSUPPORTED';

/** Uma entrada da lista (N7): a cópia sem `v` e `capturedAt`, mais o que só a lista tem. */
export interface FlyerProTemplateEntry extends Omit<FlyerProTemplateSnapshot, 'v' | 'capturedAt'> {
  pageOptions: number[];
  defaultPageCount: number;
  usable: boolean;
  unusableReason: FlyerProUnusableReason | null;
  missingFaces: FlyerProFaceKey[];
  /** O da face 0; nulo quando a face 0 não está pronta. */
  thumbnailUrl: string | null;
  updatedAt: string;
}

/** Estado calculado na leitura, nunca gravado. */
export interface FlyerProTemplateStatus {
  /** Falso: a cena foi excluída ou não existe. */
  available: boolean;
  /** Falso: hoje a cena não serviria para criar um encarte. */
  usable: boolean;
  missingFaces: FlyerProFaceKey[];
  stale: boolean;
  /** `art`: algum `pictorialKey` ou o conjunto de faces mudou; `layers`: só camadas ou nome. */
  staleKind: 'art' | 'layers' | null;
}

/** Filtros e página da lista de templates (N7), já validados. */
export interface FlyerProTemplatesListInput {
  format?: FlyerProFormat;
  search?: string;
  sceneId?: string;
  page?: number;
  limit?: number;
}

/** Os formatos de arquivo da exportação (`flyer_pro_exports.format`). */
export const FLYER_PRO_EXPORT_FORMATS = ['pdf', 'png', 'zip'] as const;
export type ExportFormat = (typeof FLYER_PRO_EXPORT_FORMATS)[number];

/** As quatro opções da etapa Exportar (`08-exportar.html#desenho`); a lista é fechada e o DTO e as regras a importam. */
export const FLYER_PRO_EXPORT_PRESETS = [
  'png-450-sheet',
  'pdf-450-all',
  'zip-450-all',
  'png-72-sheet',
] as const;
export type ExportPreset = (typeof FLYER_PRO_EXPORT_PRESETS)[number];

/** As opções com que o arquivo foi gerado, gravadas como vieram (`flyer_pro_exports.options`). */
export interface ExportOptions {
  preset: ExportPreset;
  dpi: 450 | 72;
  unit: 'sheet';
  sheets: number[];
  color: 'rgb';
  /** Só no PDF; ausente quando o pedido não traz (ou traz `null`, que vale como ausente). */
  jpegQuality?: number;
  widthPx: number;
  heightPx: number;
  bleed: boolean;
}

/** A contagem dos alertas do Pré-flight na hora de exportar, por gravidade; o servidor guarda os três números. */
export interface ExportPreflightCount {
  problems: number;
  warnings: number;
  infos: number;
}

/**
 * O registro de uma exportação como o corpo do N8 o traz, já sem os `null` (que valem como ausente em `fileSize`,
 * `preflight` e `options.jpegQuality`, D-3). O pedido não traz a hora do download: o "quando" é `createdAt`.
 */
export interface FlyerProExportEntry {
  id: string;
  format: ExportFormat;
  options: ExportOptions;
  documentRevision: number;
  engineVersion: number;
  renderDigest: string;
  fileName: string;
  fileSize?: number;
  preflight?: ExportPreflightCount;
}
