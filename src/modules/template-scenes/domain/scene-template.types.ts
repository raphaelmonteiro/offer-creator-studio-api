/**
 * Forma do template de encarte que a cena projeta (`templates.configuration`, `type = 'full'`). É o que o editor
 * de encartes lê (`frontend/src/types/template.ts`): seções em cm e elementos em px de prévia a 72 DPI.
 */

import { FaceKey } from './scene-faces';

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

/** Fundo da seção de altura 0 (a face não tem a zona, PV-11): o mesmo que o editor usa para "sem seção". */
export interface TemplateSolidBackground {
  type: 'solid';
  color: 'transparent';
  /** Sem imagem: o campo existe só para quem lê `background.imageUrl` sem olhar o tipo. */
  imageUrl?: undefined;
}

export interface TemplateSection {
  id: 'header' | 'footer';
  name: string;
  widthCm: number;
  /** 0 na zona que a face não tem: o editor trata como altura 0 e a página usa o miolo até a borda. */
  heightCm: number;
  background: TemplateImageBackground | TemplateSolidBackground;
  elements: TemplateElement[];
}

/** Marcador do template de cena (PV-9): o front lê `kind` e `sceneId`; o resto é auditoria e comparação. */
export interface TemplateSceneSource {
  kind: 'template-scene';
  sceneId: string;
  /** Face do template (`single`, `front`, `back`); ausente em template anterior às faces, que vale a face 0. */
  faceKey?: FaceKey;
  faceIndex?: number;
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
  /** Ausente na face sem a zona (seção de altura 0, sem fatia de imagem, PV-11). */
  header?: string;
  footer?: string;
  thumbnail: string;
}
