import type { EnrichStep } from './flyer-pro-job.types';

/**
 * O que cada fase do job pega no item (`a3-job-enriquecimento.html#s7-2`): o que falta fazer fica escrito no próprio item.
 * Cada critério existe de dois jeitos que dizem o mesmo, provados contra a mesma tabela de casos: o predicado sobre o
 * item lido (`isEligible`) e a condição de consulta (`criterionSql`), que filtra o `SELECT` do lote e a contagem do
 * `total` e da conferência final.
 */

type SuggestionFacts = {
  status?: string;
  auto?: boolean;
};

/** A revisão de IA do item como o banco a guarda (só o que os critérios leem). */
export type ReviewFacts = {
  checkedName?: string;
  suggestion?: SuggestionFacts | null;
};

/** O que os critérios leem do item. `strictNullChecks` desligado: ausente e `null` valem o mesmo. */
export interface EnrichItemFacts {
  name: string;
  category: string | null;
  categorySource: string | null;
  categoryReview: ReviewFacts | null;
  spellReview: ReviewFacts | null;
  imageStatus: string;
  imageOrigin: string | null;
  imageReview: ReviewFacts | null;
}

const statusOf = (review: ReviewFacts | null): string => review?.suggestion?.status ?? '';

/** Sugestão que o job aplicou sozinho (`accepted` com `auto: true`); o aceite de uma pessoa não tem `auto` (A-31). */
const appliedByJob = (review: ReviewFacts | null): boolean =>
  statusOf(review) === 'accepted' && review?.suggestion?.auto === true;

function categorizeEligible(item: EnrichItemFacts, onlyMissing: boolean): boolean {
  const source = item.categorySource ?? null;
  if (source === 'user') return false;
  if (onlyMissing) {
    const missing = (item.category ?? null) === null && source === null;
    return item.categoryReview == null && (missing || source === 'import');
  }
  if (['rejected', 'blocked'].includes(statusOf(item.categoryReview))) return false;
  return (
    source === null || source === 'import' || (source === 'ai' && appliedByJob(item.categoryReview))
  );
}

function spellEligible(item: EnrichItemFacts, onlyMissing: boolean): boolean {
  const review = item.spellReview;
  const sameName = review != null && review.checkedName === item.name;
  if (onlyMissing) return review == null || !sameName;
  return !(sameName && statusOf(review) === 'rejected');
}

const REDONE_IMAGE_STATES = ['none', 'not_found', 'review'];

function imageEligible(item: EnrichItemFacts, onlyMissing: boolean): boolean {
  if (onlyMissing) return item.imageStatus === 'none';
  if (statusOf(item.imageReview) === 'rejected') return false;
  return (
    REDONE_IMAGE_STATES.includes(item.imageStatus) ||
    (item.imageStatus === 'applied' && item.imageOrigin === 'match')
  );
}

/** O item entra na fase? Com `onlyMissing` ligado, só o que a IA ainda não olhou; desligado, também o que ela já tratou sozinha. */
export function isEligible(
  phase: EnrichStep,
  item: EnrichItemFacts,
  onlyMissing: boolean,
): boolean {
  if (phase === 'categorize') return categorizeEligible(item, onlyMissing);
  if (phase === 'spellcheck') return spellEligible(item, onlyMissing);
  return imageEligible(item, onlyMissing);
}

const sugStatus = (column: string) => `COALESCE("${column}" #>> '{suggestion,status}', '')`;

const CATEGORIZE_SQL = {
  onlyMissing: `("categoryReview" IS NULL AND (("category" IS NULL AND "categorySource" IS NULL) OR "categorySource" = 'import'))`,
  redo: `(${sugStatus('categoryReview')} NOT IN ('rejected', 'blocked') AND ("categorySource" IS NULL OR "categorySource" = 'import' OR ("categorySource" = 'ai' AND ${sugStatus('categoryReview')} = 'accepted' AND "categoryReview" #>> '{suggestion,auto}' = 'true')))`,
};

const SPELL_SQL = {
  onlyMissing: `("spellReview" IS NULL OR "spellReview" ->> 'checkedName' IS DISTINCT FROM "name")`,
  redo: `NOT ("spellReview" IS NOT NULL AND "spellReview" ->> 'checkedName' = "name" AND ${sugStatus('spellReview')} = 'rejected')`,
};

const IMAGE_SQL = {
  onlyMissing: `("imageStatus" = 'none')`,
  redo: `(${sugStatus('imageReview')} <> 'rejected' AND ("imageStatus" IN ('none', 'not_found', 'review') OR ("imageStatus" = 'applied' AND "imageOrigin" = 'match')))`,
};

const CRITERIA_SQL: Record<EnrichStep, { onlyMissing: string; redo: string }> = {
  categorize: CATEGORIZE_SQL,
  spellcheck: SPELL_SQL,
  image_match: IMAGE_SQL,
};

/** A mesma regra de `isEligible` como condição de `WHERE` sobre `flyer_pro_items`, sem parâmetros. */
export function criterionSql(phase: EnrichStep, onlyMissing: boolean): string {
  const sql = CRITERIA_SQL[phase];
  return onlyMissing ? sql.onlyMissing : sql.redo;
}

/**
 * A condição do `UPDATE` de uma foto (estado lido no início do lote): `none` ou `ean_pending` e, com `onlyMissing`
 * desligado, o estado do critério da fase. Um comando só, para o item que mudou no meio do lote não ser tocado.
 */
export function imageWriteConditionSql(onlyMissing: boolean): string {
  const open = `"imageStatus" IN ('none', 'ean_pending')`;
  return onlyMissing ? open : `(${open} OR ${IMAGE_SQL.redo})`;
}
