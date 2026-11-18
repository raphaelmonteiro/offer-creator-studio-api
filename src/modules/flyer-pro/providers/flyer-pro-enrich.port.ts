import type { AiUsageCollector } from '../../ai/utils/ai-usage';
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

/**
 * O que o provedor sabe do encarte e do job: o nome do encarte é o que o simulado lê para os marcadores. `usage` é o
 * coletor de uso da chamada (change 01), criado pelo processador: o provedor o repassa aos serviços de IA e o processador
 * o lê depois, com a chamada concluída ou não. `signal` é abortado quando o prazo do lote estoura: o provedor real o
 * repassa ao SDK da OpenAI, e a chamada abandonada deixa de ser paga.
 */
export interface EnrichCallContext {
  jobId: string;
  documentName: string;
  clientId: string;
  usage: AiUsageCollector;
  signal: AbortSignal;
  /** 0 na fase de fotos; 1 a 3 na passada do EAN pendente (`image_ean_retry`). O simulado lê a passada. */
  pass: number;
  /** O que o provedor conta sobre a chamada além das respostas por item (o processador lê depois, como o `usage`). */
  notes: EnrichCallNotes;
}

/** A busca de fotos rodou sem a busca por nome (embedding desligado ou sem chave): só EAN e nome já escolhido. */
export interface EnrichCallNotes {
  nameSearchUnavailable: boolean;
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
 * O estado do EAN do item na busca de fotos (`imageReview.eanStatus`): `null` sem EAN. Só o simulado e o provedor real o
 * preenchem; o escritor o grava na revisão.
 */
export type ImageEanStatus = string | null;

/**
 * Fotos. `apply` traz a foto já com a medida (foto sem medida nunca é `apply`); `review` traz até 3 candidatas;
 * `pending` é o EAN em consulta em segundo plano (com as candidatas pelo nome, se vieram); `not_found` não traz foto;
 * `unanswered` deixa o item como estava (sem resposta, ou sem resultado com a busca por nome indisponível).
 */
export type ImageVerdict =
  | ImageApply
  | {
      itemId: string;
      action: 'review';
      candidates: ImageCandidateVerdict[];
      eanStatus?: ImageEanStatus;
    }
  | { itemId: string; action: 'pending'; candidates: ImageCandidateVerdict[] }
  | { itemId: string; action: 'not_found'; eanStatus?: ImageEanStatus }
  | { itemId: string; action: 'unanswered' };

export interface ImageApply {
  itemId: string;
  action: 'apply';
  photo: ImageCandidateVerdict & { width: number; height: number };
  eanStatus?: ImageEanStatus;
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
