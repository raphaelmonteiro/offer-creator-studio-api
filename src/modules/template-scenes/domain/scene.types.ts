/**
 * Tipos de domínio da cena de template (estágio 3 do Template Pro). Espelhados pelo frontend em
 * `types/templateScene.ts`; `Rect` e `MaskShape` seguem `types/templateV2.ts`.
 */

export const SCENE_VERSION_OPERATIONS = [
  'generate',
  /** Redesenho da imagem inteira a partir da versão atual (change add-template-scene-conversation). */
  'redraw',
  'local_edit',
  'add_element',
  'set_layer',
  'adapt_format',
  'flatten',
  'manual',
  'restore',
  /** Verso derivado da frente por edição (change add-template-scene-faces). */
  'derive_face',
] as const;
export type SceneVersionOperation = (typeof SCENE_VERSION_OPERATIONS)[number];

export const SCENE_VERSION_STATUSES = [
  'queued',
  'running',
  'ready',
  'failed',
  'rejected',
  'cancelled',
] as const;
export type SceneVersionStatus = (typeof SCENE_VERSION_STATUSES)[number];

/** Estados em que a cena está ocupada: nenhuma outra mutação entra (D-3). */
export const SCENE_BUSY_STATUSES = [
  'queued',
  'running',
] as const satisfies readonly SceneVersionStatus[];

/** Estados finais: a versão não muda mais. */
export const SCENE_FINAL_STATUSES = [
  'ready',
  'failed',
  'rejected',
  'cancelled',
] as const satisfies readonly SceneVersionStatus[];

export const SCENE_STEPS = [
  /** O Diretor está lendo a mensagem (versão `queued`, sem imagem ainda). */
  'reading',
  'preparing',
  'generating',
  'editing',
  'checking',
  /** O texto pintado saiu diferente do pedido: segunda chamada de imagem, uma só por mensagem (D-51). */
  'retrying_text',
  'saving',
  'done',
] as const;
export type SceneStep = (typeof SCENE_STEPS)[number];

export const SCENE_ASSET_ROLES = [
  'master',
  'preview',
  'mask',
  'raw_output',
  'crop',
  'logo',
  'element',
] as const;
export type SceneAssetRole = (typeof SCENE_ASSET_ROLES)[number];

export type SceneMessageRole = 'user' | 'assistant';
export type SceneMessageStatus = 'queued' | 'done' | 'failed';

/** Códigos de falha gravados em `errorCode` da versão. */
export const SCENE_FAILURE_CODES = [
  'PROVIDER_QUOTA',
  'PROVIDER_CONTENT_POLICY',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
  'JOB_EXPIRED',
  'PAID_CALL_LIMIT',
  /** O Diretor não respondeu, estourou o tempo ou devolveu saída inválida duas vezes. */
  'DIRECTOR_UNAVAILABLE',
] as const;
export type SceneFailureCode = (typeof SCENE_FAILURE_CODES)[number];

/** Retângulo normalizado (0..1), origem no canto superior esquerdo. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Forma marcada pelo cliente (coordenadas 0..1); `radius` do pincel é fração da largura. */
export type MaskShape =
  | { kind: 'brush'; strokes: Pt[][]; radius: number }
  | { kind: 'lasso'; points: Pt[] };

export const SCENE_ELEMENT_KINDS = ['sun', 'cloud', 'logo', 'text', 'generated'] as const;
export type SceneElementKind = (typeof SCENE_ELEMENT_KINDS)[number];

/** Camada manual da cena. Imagem só por `assetId` da própria cena (a API nunca aceita URL). */
export interface SceneElement {
  id: string;
  kind: SceneElementKind;
  name: string;
  /** Centro do elemento, em fração da largura/altura da página. */
  x: number;
  y: number;
  /** Largura em fração da largura da página. */
  w: number;
  /** Largura / altura em pixels. */
  aspect: number;
  rotation: number;
  z: number;
  assetId?: string;
  glow?: boolean;
  face?: boolean;
  text?: string;
  fontFamily?: string;
  /** Tamanho da fonte em % da largura da página. */
  fontSize?: number;
  color?: string;
}

export type SceneZoneName = 'header' | 'body' | 'footer';
export type SceneZones = Record<SceneZoneName, Rect>;

/** Uma chamada paga (ou a reserva dela) em `metrics.calls` da versão. */
export interface SceneCallRecord {
  id: string;
  kind: 'generate' | 'edit' | 'vision';
  /** `pending` é gravada ANTES da chamada (R10); fechada depois com o custo real. */
  status: 'pending' | 'done' | 'failed' | 'discarded';
  model: string;
  size: string;
  startedAt: string;
  finishedAt?: string;
  costUsd?: number | null;
  requestId?: string | null;
  errorCode?: string;
}

export interface SceneVersionMetrics {
  calls?: SceneCallRecord[];
  [key: string]: unknown;
}

/** Limites do estágio 3. */
export const SCENE_LIMITS = {
  nameMaxLength: 120,
  messageMaxLength: 2000,
  logoMaxBytes: 10 * 1024 * 1024,
  listMaxLimit: 50,
  listDefaultLimit: 20,
  recentMessages: 50,
  versionsPageSize: 50,
  maxElements: 100,
} as const;
