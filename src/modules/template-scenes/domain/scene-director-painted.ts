import { fold } from '../../../shared/text/fold';
import { DirectorPlan, PaintedRefusal } from './scene-director-schema';

/**
 * Validação 4 (G3): texto, preço e logo nunca são pintados pelo modelo de imagem. Se `what_to_put` traz
 * moeda, trecho entre aspas ou termos de texto, preço ou logo como algo a colocar, o plano vira
 * `recusa_pintado`, ainda que o Diretor tenha aceitado. `what_to_change` não entra: "tira o preço" vale.
 */

const CURRENCY = /r\$\s*\d|\d\s*(?:reais|real)\b|\b\d+[.,]\d{2}\b/;
const QUOTED = /"[^"]+"|“[^”]+”|«[^»]+»/;
const LOGO_TERMS = /\b(?:logos?|logotipos?|marcas?)\b/;
const PRICE_TERMS = /\bprecos?\b/;
const TEXT_TERMS = /\b(?:escrev\w*|textos?|letreiros?)\b/;

/** Turnos em que `what_to_put` não é conteúdo pintado: camadas, desfazer e a própria recusa. */
const SKIPPED_TURNS: ReadonlySet<DirectorPlan['turn_kind']> = new Set([
  'camada',
  'desfazer',
  'recusa_pintado',
]);

/** Qual tipo de conteúdo pintado o plano pede, ou `null` se nenhum. Preço antes de logo antes de texto. */
export function paintedKindOf(whatToPut: string): PaintedRefusal | null {
  const folded = fold(whatToPut);
  if (CURRENCY.test(folded) || PRICE_TERMS.test(folded)) return 'painted_price';
  if (LOGO_TERMS.test(folded)) return 'painted_logo';
  if (QUOTED.test(whatToPut) || TEXT_TERMS.test(folded)) return 'painted_text';
  return null;
}

/**
 * Plano final: o que o Diretor recusou fica recusado (`refusal` preenche `turn_kind`), e o que ele aceitou
 * com conteúdo pintado em `what_to_put` vira recusa. Nenhuma chamada de imagem sai de um plano recusado.
 */
export function enforcePaintedRefusal(plan: DirectorPlan): DirectorPlan {
  const kind =
    plan.refusal ?? (SKIPPED_TURNS.has(plan.turn_kind) ? null : paintedKindOf(plan.what_to_put));
  if (!kind) {
    return plan.turn_kind === 'recusa_pintado'
      ? { ...plan, refusal: 'painted_text', will_change_image: false }
      : plan;
  }
  return { ...plan, turn_kind: 'recusa_pintado', refusal: kind, will_change_image: false };
}

/**
 * Textos de pedidos em aberto que podem ir ao modelo de imagem (G3). Um item que fala em texto, preço ou logo
 * continua na lista, mas não entra no prompt nem na instrução do "marquei": "tirar o preço" é pedido válido, então
 * o plano não é recusado por isso, só o item deixa de chegar ao gerador.
 */
export function promptableTexts(texts: string[]): string[] {
  return texts.filter((text) => paintedKindOf(text) === null);
}
