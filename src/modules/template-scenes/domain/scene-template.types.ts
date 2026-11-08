/**
 * Forma do template de encarte que a cena projeta (`templates.configuration`, `type = 'full'`). É o que o editor
 * de encartes lê (`frontend/src/types/template.ts`): seções em cm e elementos em px de prévia a 72 DPI.
 */

export interface TemplateImageBackground {
  type: 'image';
  imageUrl: string;
  imageSize: 'cover';
  imagePosition: 'center';
  imageOpacity: number;
}

interface TemplateElementBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  rotation: number;
}

export interface TemplateImageElement extends TemplateElementBase {
  type: 'image';
  src: string;
  alt: string;
  objectFit: 'contain';
}

export interface TemplateTextElement extends TemplateElementBase {
  type: 'text';
  content: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: 'normal';
  color: string;
  textAlign: 'center';
  lineHeight: number;
}

export type TemplateElement = TemplateImageElement | TemplateTextElement;

export interface TemplateSection {
  id: 'header' | 'footer';
  name: string;
  widthCm: number;
  heightCm: number;
  background: TemplateImageBackground;
  elements: TemplateElement[];
}

/** Marcador do template de cena (PV-9): o front lê `kind` e `sceneId`; o resto é auditoria e comparação. */
export interface TemplateSceneSource {
  kind: 'template-scene';
  sceneId: string;
  versionId: string;
  sceneRevision: number;
  pictorialKey: string;
  fingerprint: string;
  projectionVersion: number;
  syncedAt: string;
}

export interface SceneTemplateConfiguration {
  format: string;
  header: TemplateSection;
  footer: TemplateSection;
  bodyBackground: TemplateImageBackground;
  source: TemplateSceneSource;
}

/** URLs das imagens de uma projeção pictórica (reaproveitadas quando só as camadas mudam). */
export interface TemplateImageUrls {
  full: string;
  header: string;
  footer: string;
  thumbnail: string;
}
