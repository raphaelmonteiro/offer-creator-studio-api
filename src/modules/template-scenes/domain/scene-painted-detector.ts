import { fold } from '../../../shared/text/fold';
import { PaintedRefusal } from './scene-director-schema';
import {
  ACTION_VERB,
  INFINITIVE,
  PUT_VERB,
  removalMask,
  SWAP_VERB,
  Token,
  tokenize,
  TRUE_REMOVAL,
} from './scene-removal-mask';
import { CLAUSE_SEPARATOR } from './scene-written-number';

/**
 * Detector de conteúdo pintado (validação 4, D-45, D-46), com três saídas. Por trecho (vírgula, ponto e vírgula ou
 * " e "), nesta ordem:
 * - `refuse` (a): inequívoco. Preço com valor, frase entre aspas ou palavra em caixa alta quando é o que se quer
 *   colocar, verbo de escrita. Nenhuma exceção desliga por palavra solta; só o objeto de remoção ("tira o OFERTA").
 * - `doubt` (b): nome citado ou termo solto (`titulo`, `preco`, "a logo"). Refaz sem dizer "não pinto" e, persistindo,
 *   o chat pergunta.
 * - `none` (c): não é escrita ("30% mais clara", "coelhos reais", "logo abaixo", "marcas no pelo").
 */

export type PaintedLevel = 'refuse' | 'doubt' | 'none';
export interface PaintedVerdict {
  level: PaintedLevel;
  /** Só com `refuse`: o tipo de recusa. */
  kind: PaintedRefusal | null;
}
/** `put` é o que vai ser colocado (`what_to_put`); `change` é o resto (`what_to_change`, pedidos do cliente). */
export type PaintedField = 'put' | 'change';

const NONE: PaintedVerdict = { level: 'none', kind: null };

/** Depois do decimal, medida ou deslocamento: "2,50 metros", "1,25 vezes", "1,50 acima", "1,50%" não são preço (R41). */
const NOT_PRICE_AFTER =
  '(?!\\s*%|\\s*(?:m|cm|mm|km|kg|g|l|x|px|metros?|centimetros?|milimetros?|quilometros?|quilos?|gramas?|litros?|' +
  'hectares?|graus|pixels?|vezes|de\\s+(?:altura|largura|comprimento|diametro|profundidade|espessura|distancia)|acima|abaixo|cima|baixo|a\\s+direita|a\\s+esquerda|para\\s+(?:cima|baixo|a\\s+direita|a\\s+esquerda|direita|esquerda))\\b)';
const PRICE_FORM = new RegExp(
  `r\\$\\s*\\d|(?<![x×]\\s*)\\b\\d+[.,]\\d{2}\\b${NOT_PRICE_AFTER}|\\d+\\s*reais\\b|\\d\\s*%\\s*(?:off|de desconto|desconto)|%\\s*off\\b`,
);
const WRITE_VERB = /\b(?:escrev\w*|escrit[oa]s?|dizendo)\b/;
const WRITE_OBJECT =
  /\b(?:com|colocar|coloca|coloque|poe|ponha|pinta|pintar|adiciona|adicionar)\s+(?:(?:a|o|as|os|uma|um)\s+)?(?:frase|palavra|texto|dizeres)\b/;
const QUOTED = /"[^"]+"|“[^”]+”|«[^»]+»/g;
/** Duas palavras em caixa alta, ou uma de 4 letras ou mais ("FELIZ PASCOA", "OFERTA"; "TV" e "LED" não). */
const UPPERCASE_RUN = /\b[A-ZÀ-Ý]{2,}(?:\s+[A-ZÀ-Ý]{2,})+\b|\b[A-ZÀ-Ý]{4,}\b/g;
const NAME_CUE = /^(?:estilo|tipo|como|igual|chamad\w*|camada)$/;

const LOOSE_TERM = new RegExp(
  [
    '(?:textos?|letreiros?|letras|frases?|palavras?|titulos?|legendas?|slogans?|dizeres|inscrica\\w*|precos?)',
    'logotipos?|logomarcas?',
    '(?:a|o)\\s+logo(?!\\s+(?:abaixo|acima|ao lado|em cima|embaixo|depois|antes|apos|atras|perto|junto))',
    'logo\\s+d[aeo]s?',
    'a\\s+marca\\b',
    'marcas?\\s+d[aeo]s?\\b',
  ]
    .map((part) => `\\b${part}`)
    .join('|') + '\\b',
  'g',
);
const ARTICLE = '(?:(?:os|as|o|a|um|uma)\\s+)?';
const RESERVE_BEFORE = new RegExp(
  `\\b(?:espaco|area|lugar|local|vaga|livre|reserva\\w*)\\b(?:\\s+\\w+){0,3}?\\s+(?:para|pra|pros?|pras?)\\s+(?:(?:inserir|colocar)\\s+)?${ARTICLE}$`,
);
const PLACE_BEFORE = new RegExp(
  `\\b(?:atras|perto|acima|abaixo|ao lado|em volta|no lugar|em vez|onde esta\\w*|na area)\\b(?:\\s+(?:d[aeo]s?))?\\s+${ARTICLE}$`,
);
/** Artigo definido logo antes do termo ("o título", "do título", "no título"): refere o que já está na imagem. */
const DEFINITE_BEFORE = /\b(?:o|a|os|as|do|da|dos|das|no|na|nos|nas|pelo|pela|ao|aos)\s+$/;
const NO_REMOVED: ReadonlySet<string> = new Set();
const stemOf = (term: string): string => term.trim().split(/\s+/).pop()!.replace(/s$/, '');

function precedingWords(text: string, index: number, count: number): string[] {
  return fold(text.slice(0, index)).split(/\s+/).filter(Boolean).slice(-count);
}

/** Forma pedida para colocar: aspas ou caixa alta. `refuse` se é o que se quer colocar, `doubt` se é nome citado. */
function quotedForm(rest: string, placing: boolean): PaintedLevel {
  let level: PaintedLevel = 'none';
  for (const pattern of [QUOTED, UPPERCASE_RUN]) {
    for (const match of rest.matchAll(new RegExp(pattern))) {
      const cited = precedingWords(rest, match.index ?? 0, 2).some((word) => NAME_CUE.test(word));
      if (placing && !cited) return 'refuse';
      level = 'doubt';
    }
  }
  return level;
}

/**
 * O termo é seguido de nome próprio ou conteúdo ("o título Promoção de Páscoa")? Então dá nome ao que se quer escrever
 * (D-49, R43): a palavra logo depois, sem pontuação no meio, com inicial maiúscula no texto original, ou frase entre
 * aspas. Qualquer outra continuação é referência ao termo. `fold` não muda o comprimento, então o índice vale no original.
 */
function namedAfter(original: string, end: number): boolean {
  if (!/[\p{L}\d]$/u.test(original.slice(0, end))) return false;
  const next = original.slice(end).match(/^\s+(\S+)/)?.[1] ?? '';
  return /^\p{Lu}/u.test(next) || /^["“«]/.test(next);
}

function looseTerm(rest: string, removed: ReadonlySet<string>): boolean {
  const folded = fold(rest);
  for (const match of folded.matchAll(LOOSE_TERM)) {
    const before = folded.slice(0, match.index ?? 0);
    if (RESERVE_BEFORE.test(before)) continue;
    if (PLACE_BEFORE.test(before) && !new RegExp(LOOSE_TERM).test(before)) continue;
    // O que o mesmo plano manda tirar não é pedido de escrever: "o título" no `what_to_put`, com o título removido.
    const definite = DEFINITE_BEFORE.test(before) || /^(?:a|o)\s/.test(match[0]);
    if (
      definite &&
      removed.has(stemOf(match[0])) &&
      !namedAfter(rest, (match.index ?? 0) + match[0].length)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function classifyRest(
  rest: string,
  placing: boolean,
  removed: ReadonlySet<string>,
): PaintedVerdict {
  const folded = fold(rest);
  if (PRICE_FORM.test(folded)) return { level: 'refuse', kind: 'painted_price' };
  if (WRITE_VERB.test(folded) || WRITE_OBJECT.test(folded)) {
    return { level: 'refuse', kind: 'painted_text' };
  }
  const form = quotedForm(rest, placing);
  if (form === 'refuse') return { level: 'refuse', kind: 'painted_text' };
  if (form === 'doubt' || looseTerm(rest, removed)) return { level: 'doubt', kind: null };
  return NONE;
}

function classifyClause(
  tokens: Token[],
  field: PaintedField,
  removed: ReadonlySet<string>,
): PaintedVerdict {
  const swap = tokens.findIndex((token) => SWAP_VERB.test(token.folded));
  const by = swap >= 0 ? tokens.findIndex((t, i) => i > swap && t.folded === 'por') : -1;
  if (swap >= 0 && by >= 0) {
    // "troca X por Y": o X sai da imagem (objeto de remoção), e o Y é o que vai ser colocado.
    return classifyRest(
      tokens
        .slice(by + 1)
        .map((t) => t.original)
        .join(' '),
      true,
      removed,
    );
  }
  const masked = removalMask(tokens);
  const rest = tokens
    .filter((_, i) => !masked[i])
    .map((t) => t.original)
    .join(' ');
  const placing = field === 'put' || tokens.some((t, i) => !masked[i] && PUT_VERB.test(t.folded));
  return classifyRest(rest, placing, removed);
}

const RANK: Record<PaintedLevel, number> = { none: 0, doubt: 1, refuse: 2 };

/** Classifica o texto: o pior trecho vale. Preço antes de texto na recusa. */
export function classifyPainted(
  text: string,
  field: PaintedField,
  removed: ReadonlySet<string> = NO_REMOVED,
): PaintedVerdict {
  let worst: PaintedVerdict = NONE;
  for (const tokens of clausesOf(text)) {
    const verdict = classifyClause(tokens, field, removed);
    const better =
      RANK[verdict.level] > RANK[worst.level] ||
      (verdict.level === 'refuse' && worst.level === 'refuse' && verdict.kind === 'painted_price');
    if (better) worst = verdict;
  }
  return worst;
}

const hasOwnVerb = (tokens: Token[]): boolean =>
  (tokens[0] !== undefined && INFINITIVE.test(tokens[0].folded)) ||
  tokens.some((t) =>
    [TRUE_REMOVAL, SWAP_VERB, ACTION_VERB, PUT_VERB, /^dizendo$/].some((verb) =>
      verb.test(t.folded),
    ),
  );

/**
 * Os trechos do texto, em palavras. O trecho depois de " e " ou de vírgula que não tem verbo próprio herda a remoção
 * do anterior ("Remover o selo e o preço R$ 9,90"): ganha um verbo de tirar na frente (R31). Escrita tem verbo
 * próprio, então "tira o coelho e escreve OFERTA" não herda.
 */
function clausesOf(text: string): Token[][] {
  const clauses: Token[][] = [];
  let removing = false;
  for (const [index, clause] of text.split(CLAUSE_SEPARATOR).entries()) {
    if (index % 2 === 1) continue;
    let tokens = tokenize(clause);
    const own = hasOwnVerb(tokens);
    if (removing && !own) tokens = [{ original: 'tira', folded: 'tira' }, ...tokens];
    removing = tokens.some((t) => TRUE_REMOVAL.test(t.folded)) || (removing && !own);
    clauses.push(tokens);
  }
  return clauses;
}

/**
 * Os termos soltos que o texto manda tirar ("Remover o título", "troca o título por X"): `titulo`, `preco`... no
 * singular. O `what_to_put` do mesmo plano pode citá-los com artigo definido ("na área onde está o título").
 */
export function removedTerms(text: string): ReadonlySet<string> {
  const terms = new Set<string>();
  for (const tokens of clausesOf(text)) {
    const swap = tokens.findIndex((token) => SWAP_VERB.test(token.folded));
    const by = swap >= 0 ? tokens.findIndex((t, i) => i > swap && t.folded === 'por') : -1;
    const masked =
      swap >= 0 && by >= 0 ? tokens.map((_, i) => i >= swap && i < by) : removalMask(tokens);
    const gone = fold(
      tokens
        .filter((_, i) => masked[i])
        .map((t) => t.original)
        .join(' '),
    );
    for (const match of gone.matchAll(LOOSE_TERM)) terms.add(stemOf(match[0]));
  }
  return terms;
}
