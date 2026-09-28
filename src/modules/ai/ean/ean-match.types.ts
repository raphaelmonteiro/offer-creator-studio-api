/**
 * Formatos persistidos em `ean_match_items` (jsonb) — vínculo EAN planilha→galeria
 * com alta confiança (openspec/changes/vinculo-ean-planilha-alta-confianca).
 */

export type EanMatchJobStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';

export type EanMatchItemStatus =
  | 'pending'
  | 'exact'
  | 'no-image'
  | 'auto-accepted'
  | 'review'
  | 'human-accepted'
  | 'human-none'
  | 'written'
  | 'reverted';

/** Motivos que levam um item para a fila de revisão. */
export type EanReviewReason =
  | 'no-reference'
  | 'judges-disagree'
  | 'label-mismatch'
  | 'calibration-off'
  | 'collision'
  | 'manual-conflict'
  | 'erp-conflict'
  | 'unreadable-images'
  | 'invalid-judgment'
  | 'processing-error'
  | 'calibration-sample';

export type CandidateOrigin = 'brand' | 'vector';

export type VetoReason = 'quantity' | 'variant' | 'gs1-prefix';

export interface EanCandidateRecord {
  imageId: string;
  filename: string;
  url: string;
  title: string | null;
  brand: string | null;
  variant: string | null;
  quantity: string | null;
  /** Maior entre `textScore` e `vectorScore`; só para exibição. */
  score: number;
  /** Jaccard de tokens entre a descrição da planilha e o texto da imagem. */
  textScore: number | null;
  /** 1 − distância de cosseno sobre `metadata_embedding`. */
  vectorScore: number | null;
  origins: CandidateOrigin[];
  vetoes: Array<{ reason: VetoReason; detail: string }>;
}

export type ReferenceSource = 'off' | 'cosmos' | 'web' | 'none';

export interface EanReferenceRecord {
  ean: string;
  source: ReferenceSource;
  name: string | null;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
}

export type JudgeDecisionKind = 'match' | 'same-sku-multiple' | 'none';

export interface LabelReadout {
  imageId: string;
  brand: string | null;
  variant: string | null;
  quantity: string | null;
}

export interface JudgmentRecord {
  judge: 'A' | 'B';
  model: string;
  decision: JudgeDecisionKind;
  imageIds: string[];
  labelReadout: LabelReadout[];
  reason: string;
  costUsd: number;
  /** Preenchido quando o modelo não devolveu saída válida. */
  error?: string;
}

export interface AiDecisionRecord {
  decision: JudgeDecisionKind;
  imageIds: string[];
  consensus: boolean;
  autoAcceptEligible: boolean;
  /** Condições da regra de auto-aceite que falharam. */
  failed: EanReviewReason[];
}

export interface HumanDecisionRecord {
  decision: 'match' | 'none' | 'skip';
  imageIds: string[];
  userId: string;
  decidedAt: string;
}
