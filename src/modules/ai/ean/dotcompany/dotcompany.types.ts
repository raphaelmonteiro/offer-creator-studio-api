/**
 * Tipos do catálogo DotCompany por EAN (openspec/changes/catalogo-dotcompany-ean).
 */

/** Produto como a DotCompany devolve (`ProdutoCatalogoPublico`); só o que usamos é tipado. */
export interface DotcompanyProduct {
  gtin: string;
  nome: string;
  descricao?: string | null;
  marca?: string | null;
  categoria?: string | null;
  unidade?: string | null;
  embalagem?: string | null;
  peso_bruto?: number | null;
  peso_liquido?: number | null;
  imagem_url?: string | null;
  fonte?: string | null;
  nome_verificado?: boolean | null;
  [key: string]: unknown;
}

/** Um item da resposta do lote (`GtinBatchItem`) ou do single (`GtinLookupResponse`). */
export interface DotcompanyLookupItem {
  gtin: string;
  encontrado: boolean;
  produto?: DotcompanyProduct | null;
  codigo_valido?: boolean;
  motivo?: string | null;
  codigo_de_uso_interno?: boolean;
}

export type LookupStatus = 'found' | 'not_found' | 'error';

/** Quem está consumindo: o encarte (interativo) tem prioridade sobre os jobs em lote. */
export type ConsumerKind = 'interactive' | 'batch';

/** Por que o controlador negou uma chamada. */
export type BudgetDenyReason =
  | 'no_token'
  | 'rate_window'
  | 'hour_limit'
  | 'day_limit'
  | 'reserve'
  | 'no_credit';

export type ImportJobKind = 'file' | 'flyer';

export type ImportJobStatus =
  | 'pending'
  | 'running'
  /** Pausa feita pelo administrador: só volta com `resume`. */
  | 'paused'
  /** Esperando o controlador de consumo liberar (volta sozinho). */
  | 'waiting_budget'
  /** Atingiu o teto de gasto do próprio job. */
  | 'paused_cap'
  | 'done'
  | 'failed';

export type ImportItemStatus = 'pending' | 'done';

/** Resultado final de uma linha do cadastro. */
export type ImportItemResult =
  | 'imported'
  | 'already_exists'
  | 'no_image'
  | 'not_found'
  | 'invalid'
  | 'internal_use'
  | 'duplicate'
  | 'error';

export const IMPORT_ITEM_RESULTS: readonly ImportItemResult[] = [
  'imported',
  'already_exists',
  'no_image',
  'not_found',
  'invalid',
  'internal_use',
  'duplicate',
  'error',
];
