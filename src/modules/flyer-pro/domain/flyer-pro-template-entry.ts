import { faceKeysOfLayout, findFlyerProFormat, FlyerProFormatSpec } from './flyer-pro-formats';
import type { FaceRow, SceneRow, TemplateRow, TemplateSectionRow } from './flyer-pro-template-rows';
import type {
  FlyerProFaceKey,
  FlyerProTemplateBand,
  FlyerProTemplateEntry,
  FlyerProTemplateFace,
  FlyerProTemplateSnapshot,
  FlyerProUnusableReason,
  FlyerProZone,
} from './flyer-pro.types';

/** O que a regra lê: a cena, as linhas das faces dela e os templates apontados, por id. */
export interface TemplateEntryInput {
  scene: SceneRow;
  faces: FaceRow[];
  templates: ReadonlyMap<string, TemplateRow>;
}

/** O resultado da regra, antes de virar entrada da lista (N7) ou cópia (montador): uma regra só para os dois. */
export interface SceneTemplateAnalysis {
  scene: SceneRow;
  /** `null`: formato fora de 27×40 e 54×40. */
  spec: FlyerProFormatSpec | null;
  /** Só as faces prontas, em ordem de `index`. */
  faces: FlyerProTemplateFace[];
  /** As faces do layout que não estão prontas, na ordem do layout. */
  missingFaces: FlyerProFaceKey[];
  unsupported: 'FORMAT' | 'LAYOUT' | null;
  usable: boolean;
  unusableReason: FlyerProUnusableReason | null;
}

export type SupportedFormatAnalysis = SceneTemplateAnalysis & { spec: FlyerProFormatSpec };

const MARKER_KIND = 'template-scene';

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** O template da face: o `templateId` dela; na face 0 sem ele, o `approvedTemplateId` da cena. */
export const templateIdOfFace = (
  scene: Pick<SceneRow, 'approvedTemplateId'>,
  face: Pick<FaceRow, 'index' | 'templateId'>,
): string | null => face.templateId ?? (face.index === 0 ? scene.approvedTemplateId : null);

/** Os ids de template que as faces apontam, sem repetição: o que a terceira consulta busca. */
export function templateIdsOf(scene: SceneRow, faces: FaceRow[]): string[] {
  const ids = faces.map((face) => templateIdOfFace(scene, face));
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Faixa projetada; seção de altura 0 (ou sem imagem) é a zona que a face não tem. */
function bandOf(section: TemplateSectionRow | null): FlyerProTemplateBand | null {
  const imageUrl = section?.background?.imageUrl;
  if (!section || !imageUrl || !(section.heightCm > 0)) return null;
  return {
    imageUrl,
    widthCm: section.widthCm,
    heightCm: section.heightCm,
    elements: [...(section.elements ?? [])],
  };
}

/** Zonas em % da altura da arte, com 2 casas, pelas alturas que a projeção gravou. */
export function zonesOf(
  header: Pick<FlyerProTemplateBand, 'heightCm'> | null,
  footer: Pick<FlyerProTemplateBand, 'heightCm'> | null,
  artHeightCm: number,
): { header: FlyerProZone; footer: FlyerProZone } {
  const percent = (band: Pick<FlyerProTemplateBand, 'heightCm'> | null): number =>
    band ? (band.heightCm / artHeightCm) * 100 : 0;
  return {
    header: { from: 0, to: round2(percent(header)) },
    footer: { from: footer ? round2(100 - percent(footer)) : 100, to: 100 },
  };
}

function faceOf(scene: SceneRow, row: FaceRow, template: TemplateRow): FlyerProTemplateFace {
  const header = bandOf(template.header);
  const footer = bandOf(template.footer);
  const source = template.source as NonNullable<TemplateRow['source']>;
  return {
    key: row.key as FlyerProFaceKey,
    index: row.index,
    label: row.label,
    templateId: template.id,
    artUrl: template.artUrl as string,
    thumbnailUrl: template.thumbnailUrl ?? null,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    zones: zonesOf(header, footer, scene.artHeightCm),
    header,
    footer,
    pictorialKey: source.pictorialKey,
    fingerprint: source.fingerprint,
    syncedAt: source.syncedAt,
  };
}

/** Face pronta: o template apontado existe e traz o marcador de cena (A-11). */
function readyTemplateOf(input: TemplateEntryInput, row: FaceRow): TemplateRow | null {
  const id = templateIdOfFace(input.scene, row);
  const template = id ? input.templates.get(id) : undefined;
  return template?.source?.kind === MARKER_KIND ? template : null;
}

function unsupportedOf(
  scene: SceneRow,
  spec: FlyerProFormatSpec | null,
): 'FORMAT' | 'LAYOUT' | null {
  if (!spec) return 'FORMAT';
  return spec.layouts.includes(scene.layout as never) ? null : 'LAYOUT';
}

function reasonOf(
  unsupported: 'FORMAT' | 'LAYOUT' | null,
  missingFaces: FlyerProFaceKey[],
): FlyerProUnusableReason | null {
  if (unsupported) return 'LAYOUT_UNSUPPORTED';
  return missingFaces.length > 0 ? 'FACE_MISSING' : null;
}

/**
 * A regra do template do Encarte Pro: quais faces do layout da cena estão prontas, as zonas, as faixas e o motivo de a
 * cena não servir. A lista (N7) e o montador da cópia chamam esta função, então as duas dão o mesmo resultado.
 */
export function analyzeSceneTemplate(input: TemplateEntryInput): SceneTemplateAnalysis {
  const { scene } = input;
  const layoutKeys = faceKeysOfLayout(scene.layout);
  const faces = input.faces
    .filter((row) => layoutKeys.includes(row.key as FlyerProFaceKey))
    .sort((a, b) => a.index - b.index)
    .flatMap((row) => {
      const template = readyTemplateOf(input, row);
      return template ? [faceOf(scene, row, template)] : [];
    });
  const missingFaces = layoutKeys.filter((key) => !faces.some((face) => face.key === key));
  const spec = findFlyerProFormat(scene.formatId);
  const unsupported = unsupportedOf(scene, spec);
  const unusableReason = reasonOf(unsupported, missingFaces);
  return {
    scene,
    spec,
    faces,
    missingFaces,
    unsupported,
    usable: unusableReason === null,
    unusableReason,
  };
}

export const isFormatSupported = (
  analysis: SceneTemplateAnalysis,
): analysis is SupportedFormatAnalysis => analysis.spec !== null;

/** A entrada da lista; `null` para a cena que não entra (formato fora ou nenhuma face pronta). */
export function toTemplateEntry(analysis: SceneTemplateAnalysis): FlyerProTemplateEntry | null {
  if (!isFormatSupported(analysis) || analysis.faces.length === 0) return null;
  const { scene, spec, faces } = analysis;
  const front = faces.find((face) => face.index === 0);
  return {
    sceneId: scene.id,
    name: scene.name,
    format: spec.format,
    fold: spec.fold,
    layout: scene.layout as FlyerProTemplateEntry['layout'],
    pageOptions: [...spec.pageOptions],
    defaultPageCount: spec.defaultPageCount,
    usable: analysis.usable,
    unusableReason: analysis.unusableReason,
    missingFaces: analysis.missingFaces,
    thumbnailUrl: front?.thumbnailUrl ?? null,
    sceneRevision: scene.revision,
    updatedAt: scene.updatedAt.toISOString(),
    faces,
  };
}

/** A cópia congelada do template da cena de hoje. O formato tem de ser suportado: quem chama já recusou o resto. */
export function toTemplateSnapshot(
  analysis: SupportedFormatAnalysis,
  capturedAt: string,
): FlyerProTemplateSnapshot {
  const { scene, spec } = analysis;
  return {
    v: 1,
    sceneId: scene.id,
    name: scene.name,
    format: spec.format,
    fold: spec.fold,
    layout: scene.layout as FlyerProTemplateSnapshot['layout'],
    faces: analysis.faces,
    sceneRevision: scene.revision,
    capturedAt,
  };
}
