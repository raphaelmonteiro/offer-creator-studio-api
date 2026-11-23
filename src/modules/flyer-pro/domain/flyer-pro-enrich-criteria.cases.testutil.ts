import type { EnrichItemFacts, ReviewFacts } from './flyer-pro-enrich-criteria';
import type { EnrichPhase } from './flyer-pro-job.types';

/**
 * A tabela de casos dos critérios das fases (só testes): o predicado (`isEligible`) e a condição de consulta
 * (`criterionSql`) são provados contra ela, um caso por linha, para os dois nunca divergirem.
 */

export interface CriterionCase {
  label: string;
  phase: EnrichPhase;
  /** O item, sobre a base: sem categoria, sem revisão e sem foto. */
  item: Partial<EnrichItemFacts>;
  /** Entra na fase com `onlyMissing` ligado e desligado, nesta ordem. */
  eligible: [boolean, boolean];
}

export const BASE_ITEM: EnrichItemFacts = {
  name: 'ABACATE',
  category: null,
  categorySource: null,
  categoryReview: null,
  spellReview: null,
  imageStatus: 'none',
  imageOrigin: null,
  imageReview: null,
};

const suggestion = (status: string, extra: object = {}): ReviewFacts => ({
  suggestion: { status, ...extra },
});

/** A categoria aplicada sozinha pelo job (`accepted` com `auto`) e a aceita por uma pessoa (sem `auto`). */
const AUTO = suggestion('accepted', { auto: true });
const BY_PERSON = suggestion('accepted', { decidedByUserId: 'ana' });

export const CRITERION_CASES: CriterionCase[] = [
  { label: 'sem categoria e sem revisão', phase: 'categorize', item: {}, eligible: [true, true] },
  {
    label: 'categoria da planilha, sem revisão',
    phase: 'categorize',
    item: { category: 'Mercearia', categorySource: 'import' },
    eligible: [true, true],
  },
  {
    label: 'categoria trocada à mão',
    phase: 'categorize',
    item: { category: 'Hortifruti', categorySource: 'user' },
    eligible: [false, false],
  },
  {
    label: 'categoria da IA aplicada sozinha',
    phase: 'categorize',
    item: { category: 'Bebidas', categorySource: 'ai', categoryReview: AUTO },
    eligible: [false, true],
  },
  {
    label: 'categoria da IA aceita por uma pessoa',
    phase: 'categorize',
    item: { category: 'Carnes', categorySource: 'ai', categoryReview: BY_PERSON },
    eligible: [false, false],
  },
  {
    label: 'planilha com a sugestão recusada',
    phase: 'categorize',
    item: {
      category: 'Mercearia',
      categorySource: 'import',
      categoryReview: suggestion('rejected'),
    },
    eligible: [false, false],
  },
  {
    label: 'sem categoria e com a sugestão bloqueada',
    phase: 'categorize',
    item: { categoryReview: suggestion('blocked') },
    eligible: [false, false],
  },
  {
    label: 'sem categoria, a IA olhou e não tem sugestão',
    phase: 'categorize',
    item: { categoryReview: { suggestion: null } },
    eligible: [false, true],
  },
  {
    label: 'sem categoria, sugestão pendente',
    phase: 'categorize',
    item: { categoryReview: suggestion('pending') },
    eligible: [false, true],
  },
  { label: 'sem revisão de ortografia', phase: 'spellcheck', item: {}, eligible: [true, true] },
  {
    label: 'ortografia conferida, sugestão pendente, mesmo nome',
    phase: 'spellcheck',
    item: { spellReview: { checkedName: 'ABACATE', ...suggestion('pending') } },
    eligible: [false, true],
  },
  {
    label: 'ortografia conferida sem erro, mesmo nome',
    phase: 'spellcheck',
    item: { spellReview: { checkedName: 'ABACATE', suggestion: null } },
    eligible: [false, true],
  },
  {
    label: 'ortografia recusada para o nome atual',
    phase: 'spellcheck',
    item: { spellReview: { checkedName: 'ABACATE', ...suggestion('rejected') } },
    eligible: [false, false],
  },
  {
    label: 'ortografia recusada, nome editado depois',
    phase: 'spellcheck',
    item: { spellReview: { checkedName: 'ABACATE VELHO', ...suggestion('rejected') } },
    eligible: [true, true],
  },
  { label: 'sem foto', phase: 'image_match', item: {}, eligible: [true, true] },
  {
    label: 'foto não encontrada',
    phase: 'image_match',
    item: { imageStatus: 'not_found' },
    eligible: [false, true],
  },
  {
    label: 'foto para revisar, sugestão pendente',
    phase: 'image_match',
    item: { imageStatus: 'review', imageReview: suggestion('pending') },
    eligible: [false, true],
  },
  {
    label: 'foto para revisar, candidatas recusadas',
    phase: 'image_match',
    item: { imageStatus: 'review', imageReview: suggestion('rejected') },
    eligible: [false, false],
  },
  {
    label: 'foto não encontrada, candidatas recusadas',
    phase: 'image_match',
    item: { imageStatus: 'not_found', imageReview: suggestion('rejected') },
    eligible: [false, false],
  },
  {
    label: 'foto aplicada pelo casamento do job',
    phase: 'image_match',
    item: { imageStatus: 'applied', imageOrigin: 'match' },
    eligible: [false, true],
  },
  ...['picker', 'upload', 'pixabay', 'suggestion'].map(
    (origin): CriterionCase => ({
      label: `foto aplicada por escolha humana (${origin})`,
      phase: 'image_match',
      item: { imageStatus: 'applied', imageOrigin: origin },
      eligible: [false, false],
    }),
  ),
  {
    label: 'foto removida',
    phase: 'image_match',
    item: { imageStatus: 'removed' },
    eligible: [false, false],
  },
  {
    label: 'EAN pendente: a fase de fotos não o lê, a passada do EAN sim',
    phase: 'image_match',
    item: { imageStatus: 'ean_pending' },
    eligible: [false, false],
  },
  ...['none', 'review', 'not_found', 'removed'].map(
    (imageStatus): CriterionCase => ({
      label: `passada do EAN: foto ${imageStatus} não é pendente`,
      phase: 'image_ean_retry',
      item: { imageStatus },
      eligible: [false, false],
    }),
  ),
  {
    label: 'passada do EAN: foto aplicada não é pendente',
    phase: 'image_ean_retry',
    item: { imageStatus: 'applied', imageOrigin: 'match' },
    eligible: [false, false],
  },
  {
    label: 'passada do EAN: item pendente entra, com onlyMissing ligado ou desligado',
    phase: 'image_ean_retry',
    item: { imageStatus: 'ean_pending' },
    eligible: [true, true],
  },
];
