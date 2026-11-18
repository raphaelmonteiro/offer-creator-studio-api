import type { EnrichStep } from '../domain/flyer-pro-job.types';

/**
 * A porta do provedor do job de enriquecimento (change 28): o processador só fala com ela, nunca com os serviços de IA
 * direto. Duas implementações, escolhidas por `FLYER_PRO_ENRICH_PROVIDER`: o simulado (`mock`, sem rede e sem custo) e o
 * `real`, que a change 29 preenche. A chamada que falha LANÇA `TransientProviderError` ou `TerminalProviderError`.
 */

export const FLYER_PRO_ENRICH_PORT = 'FLYER_PRO_ENRICH_PORT';

/** O item como o provedor o lê: só o que as três fases usam. */
export interface EnrichItemInput {
  id: string;
  name: string;
  sourceName: string | null;
  category: string | null;
  categorySource: string | null;
  unit: string;
  ean: string | null;
  position: number;
  imported: Record<string, unknown> | null;
}

/** O que o provedor sabe do encarte e do job: o nome do encarte é o que o simulado lê para os marcadores. */
export interface EnrichCallContext {
  jobId: string;
  documentName: string;
  clientId: string;
}

/**
 * Categorias. `apply` é "certeza": o job só aplica com `autoApply` ligado e nunca sobre a categoria da planilha;
 * `suggest` é sugestão pendente; `none` é "a IA olhou e não tem sugestão"; `unanswered` deixa o item como "falta fazer".
 */
export type CategoryVerdict = CategoryChoice | { itemId: string; action: 'none' | 'unanswered' };

export interface CategoryChoice {
  itemId: string;
  action: 'apply' | 'suggest';
  category: string;
  confidence: number;
  why: string | null;
}

/** Ortografia: nunca é aplicada sozinha. `suggest` traz o nome corrigido. */
export type SpellVerdict =
  | { itemId: string; action: 'suggest'; value: string }
  | { itemId: string; action: 'clean' | 'unanswered' };

/** A foto do acervo; `width` e `height` vêm da medida do arquivo. */
export interface PhotoPick {
  galleryImageId: string;
  url: string;
  thumbnailUrl: string | null;
}

export interface ImageCandidateVerdict extends PhotoPick {
  score: number;
  reasons: string[];
  isClientPreferred: boolean;
}

/**
 * Fotos. `apply` traz a foto já com a medida (foto sem medida nunca é `apply`); `review` traz até 3 candidatas;
 * `not_found` e `unanswered` não trazem foto.
 */
export type ImageVerdict =
  | ImageApply
  | { itemId: string; action: 'review'; candidates: ImageCandidateVerdict[] }
  | { itemId: string; action: 'not_found' | 'unanswered' };

export interface ImageApply {
  itemId: string;
  action: 'apply';
  photo: ImageCandidateVerdict & { width: number; height: number };
}

export interface FlyerProEnrichPort {
  /** A fase pode rodar? `false`: o job a pula com `skipped: 'AI_DISABLED'`, sem tocar nos itens. */
  isAvailable(phase: EnrichStep): boolean;
  /** O modelo da fase, gravado em `models` (`"mock"` no simulado). */
  modelOf(phase: EnrichStep): string;
  categorize(items: EnrichItemInput[], context: EnrichCallContext): Promise<CategoryVerdict[]>;
  spellcheck(items: EnrichItemInput[], context: EnrichCallContext): Promise<SpellVerdict[]>;
  matchImages(items: EnrichItemInput[], context: EnrichCallContext): Promise<ImageVerdict[]>;
}
