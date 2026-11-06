import { fold } from '../../../shared/text/fold';
import { DirectorPlan, PaintedRefusal } from './scene-director-schema';
import { CLAUSE_SEPARATOR, hasWrittenNumber } from './scene-written-number';

/**
 * Validação 4 (G3): texto, preço e logo não são pintados pelo modelo de imagem. Um detector só, por trecho, em todo
 * campo que vai ao modelo; remoção, negação, reserva e referência de lugar não contam ("tira o preço" vale).
 */

/** Moeda, percentual e preço em reais: forma de preço, sem acento. */
const PRICE_FORM = /r\$\s*\d|\d\s*(?:reais|real)\b|\breais\b|\b\d+[.,]\d{2}\b|\d\s*%|%\s*off\b/;
const QUOTED = /"[^"]+"|“[^”]+”|«[^»]+»/;
/** Sequência em caixa alta no texto original: duas palavras, ou uma de 4 letras ou mais ("FELIZ PASCOA", "OFERTA"; "TV" não). */
const UPPERCASE_RUN = /\b[A-ZÀ-Ý]{2,}(?:\s+[A-ZÀ-Ý]{2,})+\b|\b[A-ZÀ-Ý]{4,}\b/;
const LOGO_TERMS = /\b(?:logos?|logotipos?|marcas?)\b/;
const PRICE_TERMS = /\bprecos?\b/;
const TEXT_TERMS =
  /\b(?:escrev\w*|escrit\w*|textos?|letreiros?|letras|dizer\w*|dizendo|frases?|palavras?|titulos?|legendas?|slogans?|inscricao|inscricoes)\b/;
const ALL_TERMS =
  '(?:escrev\\w*|escrit\\w*|textos?|letreiros?|letras|dizer\\w*|dizendo|frases?|palavras?|titulos?|legendas?|slogans?|inscrica\\w*|precos?|logos?|logotipos?|marcas?)';

/**
 * Trecho que não pede escrita, ainda que cite um termo: tira ("tira o preço"), nega ("sem texto legível"), reserva
 * lugar ("espaço para os preços", "lugar pros preços") ou usa como referência de lugar ("atrás do título").
 */
const REMOVAL =
  /\b(?:tir(?:a|ar|e|em|ei)|retir(?:a|ar|e|em)|remov(?:a|e|er|em)|apag(?:a|ar|ue|uem)|elimin(?:a|ar|e|em))\b/;
const NEGATION = /\bsem\b/;
const RESERVE =
  /\b(?:espaco|area|lugar|local|vaga|campo|reservar|reserva\w*|adequad\w*|apropriad\w*|ideal|pront[oa]s?|livre|disponivel|vazi[oa]s?|limp[oa]s?)\b.*\b(?:para|pra|pro|pros|pras)\b/;
const PLACE_REFERENCE = new RegExp(
  `\\b(?:atras|perto|acima|abaixo|ao lado|em volta|ao redor|embaixo|junto|proximo|diante|frente)\\b(?:\\s+\\w+){0,3}?\\s+${ALL_TERMS}`,
);
/** "Troca X por Y": só o Y vai ao modelo, o X sai da imagem. */
const SWAP = /\b(?:troc\w*|substitu\w*)\b/;

function clauseKind(original: string): PaintedRefusal | null {
  let text = original;
  const folded = fold(text);
  if (SWAP.test(folded)) {
    const at = folded.search(/\bpor\b/);
    if (at >= 0) text = text.slice(at + 3);
  }
  const f = fold(text);
  if (REMOVAL.test(f) || NEGATION.test(f) || RESERVE.test(f) || PLACE_REFERENCE.test(f))
    return null;
  if (PRICE_FORM.test(f) || PRICE_TERMS.test(f)) return 'painted_price';
  if (LOGO_TERMS.test(f)) return 'painted_logo';
  if (QUOTED.test(text) || UPPERCASE_RUN.test(text) || TEXT_TERMS.test(f)) return 'painted_text';
  return null;
}

/** Turnos em que `what_to_put` não é conteúdo pintado: camadas, desfazer e a própria recusa. */
const SKIPPED_TURNS: ReadonlySet<DirectorPlan['turn_kind']> = new Set([
  'camada',
  'desfazer',
  'recusa_pintado',
]);

/**
 * Qual tipo de conteúdo pintado o texto pede, ou `null` se nenhum. Olha cada trecho (vírgula, ponto e vírgula ou
 * " e "): "tira o preço, coloca flores" não pede preço. Preço antes de logo antes de texto.
 */
export function paintedKindOf(text: string): PaintedRefusal | null {
  const kinds = text
    .split(CLAUSE_SEPARATOR)
    .filter((_, index) => index % 2 === 0)
    .map(clauseKind);
  return kinds.includes('painted_price')
    ? 'painted_price'
    : kinds.includes('painted_logo')
      ? 'painted_logo'
      : kinds.includes('painted_text')
        ? 'painted_text'
        : null;
}

/** Tipo da escrita que o Diretor declarou em `written_content`: o do termo, ou texto se for só uma palavra. */
function declaredKind(plan: DirectorPlan): PaintedRefusal | null {
  const items = (plan.written_content ?? []).map((item) => item.trim()).filter(Boolean);
  return items.length ? (paintedKindOf(items.join(', ')) ?? 'painted_text') : null;
}

/**
 * Plano final: o que o Diretor recusou fica recusado (`refusal` preenche `turn_kind`), e o que ele aceitou
 * com conteúdo pintado em `what_to_put`, ou declarado em `written_content`, vira recusa. Nenhuma chamada de
 * imagem sai de um plano recusado.
 */
export function enforcePaintedRefusal(plan: DirectorPlan): DirectorPlan {
  const kind =
    plan.refusal ??
    (SKIPPED_TURNS.has(plan.turn_kind)
      ? null
      : (paintedKindOf(plan.what_to_put) ?? declaredKind(plan)));
  if (!kind) {
    return plan.turn_kind === 'recusa_pintado'
      ? { ...plan, refusal: 'painted_text', will_change_image: false }
      : plan;
  }
  return { ...plan, turn_kind: 'recusa_pintado', refusal: kind, will_change_image: false };
}

export type PaintedCheck = { kind: 'ok'; plan: DirectorPlan } | { kind: 'retry'; reason: string };

export const PAINTED_RETRY_REASON =
  'o plano pede texto, número, preço ou logo escritos na imagem em what_to_change; isso é camada, nunca pintura: não peça escrita ao modelo de imagem';

/**
 * Validação 4 inteira (R2, R3, D-45): `what_to_put` e `written_content` recusam na hora; `inventory_keep` perde o
 * item com conteúdo pintado, sem refazer; `what_to_change` refaz uma vez e, persistindo (`final`), recusa. Não corta
 * trecho: o cliente pode ter pedido a escrita, e a resposta certa é oferecer a camada.
 */
export function checkPainted(plan: DirectorPlan, options: { final: boolean }): PaintedCheck {
  const enforced = enforcePaintedRefusal(plan);
  if (enforced.turn_kind === 'recusa_pintado') return { kind: 'ok', plan: enforced };
  const keep = enforced.inventory_keep.filter((item) => paintedKindOf(item) === null);
  const cleaned =
    keep.length === enforced.inventory_keep.length
      ? enforced
      : { ...enforced, inventory_keep: keep };
  const kind = SKIPPED_TURNS.has(cleaned.turn_kind) ? null : paintedKindOf(cleaned.what_to_change);
  if (!kind) return { kind: 'ok', plan: cleaned };
  if (!options.final) return { kind: 'retry', reason: PAINTED_RETRY_REASON };
  return {
    kind: 'ok',
    plan: { ...cleaned, turn_kind: 'recusa_pintado', refusal: kind, will_change_image: false },
  };
}

/**
 * Textos de pedidos em aberto que podem ir ao modelo de imagem (G3, D-42: também sem ano, data ou número). Um item que fala em texto, preço ou logo
 * continua na lista, mas não entra no prompt nem na instrução do "marquei": "tirar o preço" é pedido válido, então
 * o plano não é recusado por isso, só o item deixa de chegar ao gerador.
 */
export function promptableTexts(texts: string[]): string[] {
  return texts.filter(
    (text) => paintedKindOf(text) === null && !hasWrittenNumber(text, { removal: true }),
  );
}
