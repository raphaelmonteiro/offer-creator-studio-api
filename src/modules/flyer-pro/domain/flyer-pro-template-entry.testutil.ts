import type { FlyerProFaceKey } from './flyer-pro.types';
import type { FaceRow, SceneRow, TemplateRow, TemplateSectionRow } from './flyer-pro-template-rows';
import {
  analyzeSceneTemplate,
  TemplateEntryInput,
  toTemplateEntry,
} from './flyer-pro-template-entry';

export const SCENE_ID = '11111111-1111-4111-8111-111111111111';
export const TEMPLATE_BASE = 'http://cdn.test/uploads/templates';

const FACES: Record<string, { index: number; label: string | null }> = {
  single: { index: 0, label: null },
  front: { index: 0, label: 'Frente' },
  back: { index: 1, label: 'Verso' },
  outer: { index: 0, label: 'Externa' },
  inner: { index: 1, label: 'Interna' },
};

export const templateIdOf = (key: string) => `tpl-${key}`;

export function sceneRow(overrides: Partial<SceneRow> = {}): SceneRow {
  return {
    id: SCENE_ID,
    name: 'Cena de teste',
    formatId: 'folheto-27x40',
    layout: 'single',
    artHeightCm: 41,
    revision: 5,
    updatedAt: new Date('2026-11-13T02:32:08.690Z'),
    approvedTemplateId: null,
    deletedAt: null,
    ...overrides,
  };
}

export function faceRow(key: FlyerProFaceKey, overrides: Partial<FaceRow> = {}): FaceRow {
  return {
    sceneId: SCENE_ID,
    index: FACES[key].index,
    key,
    label: FACES[key].label,
    widthPx: 2352,
    heightPx: 3504,
    templateId: templateIdOf(key),
    ...overrides,
  };
}

/** Seção da projeção: `heightCm` 0 é a zona que a face não tem (sem imagem, como a projeção grava). */
export function sectionRow(
  name: string,
  heightCm: number,
  overrides: Partial<TemplateSectionRow> = {},
): TemplateSectionRow {
  const base = { widthCm: 27.5, heightCm };
  return heightCm > 0
    ? {
        ...base,
        background: { imageUrl: `${TEMPLATE_BASE}/${name}.jpg` },
        elements: [],
        ...overrides,
      }
    : { ...base, background: { imageUrl: undefined }, elements: [], ...overrides };
}

/** O que a projeção real grava por face: cabeçalho de 6,15 cm na frente, na externa e na face única; rodapé de 4,1 cm no verso, na externa e na face única; a interna não tem nenhum. */
const SECTIONS: Record<string, { header: number; footer: number }> = {
  single: { header: 6.15, footer: 4.1 },
  front: { header: 6.15, footer: 0 },
  back: { header: 0, footer: 4.1 },
  outer: { header: 6.15, footer: 4.1 },
  inner: { header: 0, footer: 0 },
};

export function templateRow(
  key: FlyerProFaceKey,
  overrides: Partial<TemplateRow> = {},
): TemplateRow {
  return {
    id: templateIdOf(key),
    thumbnailUrl: `${TEMPLATE_BASE}/${key}/thumbnail.jpg`,
    artUrl: `${TEMPLATE_BASE}/${key}/full.jpg`,
    source: {
      kind: 'template-scene',
      pictorialKey: `pictorial-${key}`,
      fingerprint: `fingerprint-${key}`,
      syncedAt: '2026-11-13T02:29:10.437Z',
    },
    header: sectionRow(`${key}/header`, SECTIONS[key].header),
    footer: sectionRow(`${key}/footer`, SECTIONS[key].footer),
    ...overrides,
  };
}

export interface EntryInputOptions {
  scene?: Partial<SceneRow>;
  /** Chaves das faces que o layout tem (as linhas de `template_scene_faces`). Padrão: as do layout. */
  faces?: FlyerProFaceKey[];
  /** Chaves cujo template existe e tem o marcador. Padrão: todas as faces. */
  ready?: FlyerProFaceKey[];
  faceOverrides?: Partial<Record<FlyerProFaceKey, Partial<FaceRow>>>;
  templateOverrides?: Partial<Record<FlyerProFaceKey, Partial<TemplateRow>>>;
}

const KEYS_OF_LAYOUT: Record<string, FlyerProFaceKey[]> = {
  single: ['single'],
  front_back: ['front', 'back'],
  tabloid: ['outer', 'inner'],
};

/** Cena, linhas das faces e templates prontos, no formato que a função pura recebe. */
export function entryInput(
  options: EntryInputOptions = {},
): TemplateEntryInput & { templates: Map<string, TemplateRow> } {
  const scene = sceneRow(options.scene);
  const faces = options.faces ?? KEYS_OF_LAYOUT[scene.layout];
  const ready = options.ready ?? faces;
  const templates = new Map<string, TemplateRow>(
    ready.map((key) => [
      options.faceOverrides?.[key]?.templateId ?? templateIdOf(key),
      templateRow(key, options.templateOverrides?.[key]),
    ]),
  );
  return {
    scene,
    faces: faces.map((key) => faceRow(key, options.faceOverrides?.[key])),
    templates,
  };
}

/** A entrada da lista de uma cena montada pelas opções (`null` se a cena não entra). */
export const entryOf = (options?: EntryInputOptions) =>
  toTemplateEntry(analyzeSceneTemplate(entryInput(options)));
