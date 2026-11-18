import type { EnrichItemFacts } from '../domain/flyer-pro-enrich-criteria';
import type { EnrichStep } from '../domain/flyer-pro-job.types';
import type {
  CategoryVerdict,
  EnrichItemInput,
  ImageVerdict,
  SpellVerdict,
} from '../providers/flyer-pro-enrich.port';

/** O que a fila entrega a cada lote: o job e a ficha que o lote espera encontrar (`batchSeq`). */
export interface BatchMessage {
  jobId: string;
  seq: number;
}

/** O item lido para o lote: o que o provedor vê e o estado em que ele estava, que condiciona cada escrita. */
export interface EnrichItemRow extends EnrichItemFacts, EnrichItemInput {}

/** Um `UPDATE` de um item, condicionado ao estado lido; `count` é a contagem do `result` que ele alimenta. */
export interface ItemWrite {
  sql: string;
  params: unknown[];
  count: 'applied' | 'suggested' | 'unchanged' | 'clean' | 'review' | 'notFound';
}

/** A resposta do provedor com os itens que a motivaram: o necessário para planejar as escritas. */
export type PhaseWork =
  | { phase: 'categorize'; items: EnrichItemRow[]; verdicts: CategoryVerdict[] }
  | { phase: 'spellcheck'; items: EnrichItemRow[]; verdicts: SpellVerdict[] }
  | { phase: 'image_match'; items: EnrichItemRow[]; verdicts: ImageVerdict[] };

/** O que uma mensagem da fila decidiu fazer, para a transação gravar de uma vez (uma unidade de trabalho). */
export interface UnitPlan {
  phase: EnrichStep;
  /** O lote tem trabalho do provedor (itens e respostas); `null` quando só fecha ou pula a fase. */
  work: PhaseWork | null;
  /** Tamanho da fase: lote menor que ele fecha a fase na própria gravação. */
  batchSize: number;
  /** A fase foi declarada indisponível pela porta: fecha com `skipped`, sem tocar item. */
  skipped: boolean;
  /** Itens que o pulo dá por visitados, para `processed` chegar a `total`. */
  skippedItems: number;
  /** O modelo da fase, quando o provedor foi chamado. */
  model: string | null;
  /** Em ms: do lote assumido até agora, e só a chamada ao provedor. */
  totalMs: number;
  providerMs: number;
}
