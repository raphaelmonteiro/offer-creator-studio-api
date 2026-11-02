/** Tipos compartilhados do spike. Coordenadas normalizadas 0..1 com origem no canto superior esquerdo. */

export interface Pt {
  x: number;
  y: number;
}

/** Mesmo formato de `frontend/src/types/templateV2.ts`. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type MaskShape =
  | { kind: 'brush'; strokes: Pt[][]; radius: number }
  | { kind: 'lasso'; points: Pt[] };

export type ZoneName = 'header' | 'footer';

/** Forma de um pedido: retângulo, pincel/laço ou zona nomeada. */
export type RegionSpec =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'zone'; zone: ZoneName }
  | MaskShape;

export interface SceneCase {
  id: string;
  formatId: string;
  prompt: string;
}

export interface EditCase {
  id: string;
  block: 'A' | 'C';
  sceneId: string;
  target: string;
  prompt: string;
  kind: string;
  /** Forma exigida pelo plano (design D-3). */
  shapeKind: 'rect' | 'brush' | 'lasso' | 'zone';
  zone?: ZoneName;
  /** Retângulo marcado (caixa envolvente). */
  region?: Rect;
  mask?: MaskShape;
  /** Só bloco C: área da nuvem (vizinha), dentro do retângulo e fora do pincel. */
  neighbor?: Rect;
}

export interface PromotionCase {
  id: string;
  sceneId: string;
  target: string;
  atmospheric: boolean;
  prompt: string;
  source?: { region: Rect; mask?: MaskShape };
  destination?: Rect;
}

export interface CasesFile {
  version: number;
  scenes: SceneCase[];
  edits: EditCase[];
  /** Pedidos do bloco A repetidos com margem de 8% (só `mask`). */
  marginSubset: string[];
  promotions: PromotionCase[];
}

export type CaseStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface CaseState {
  status: CaseStatus;
  reason?: string;
  updatedAt: string;
}

export interface UsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Tipo de chamada paga, usado na reserva do disjuntor. */
export type CallKind = 'generate' | 'edit' | 'vision' | 'remove_bg';
