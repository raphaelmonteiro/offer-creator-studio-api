import { fold } from '../../../shared/text/fold';
import { PaintedRefusal } from './scene-director-schema';
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

const PRICE_FORM =
  /r\$\s*\d|\b\d+[.,]\d{2}\b|\d+\s*reais\b|\d\s*%\s*(?:off|de desconto|desconto)|%\s*off\b/;
const WRITE_VERB = /\b(?:escrev\w*|escrit\w*|dizendo)\b/;
const WRITE_OBJECT =
  /\b(?:com|colocar|coloca|coloque|poe|ponha|pinta|pintar|adiciona|adicionar)\s+(?:(?:a|o|as|os|uma|um)\s+)?(?:frase|palavra|texto|dizeres)\b/;
const QUOTED = /"[^"]+"|“[^”]+”|«[^»]+»/g;
/** Duas palavras em caixa alta, ou uma de 4 letras ou mais ("FELIZ PASCOA", "OFERTA"; "TV" e "LED" não). */
const UPPERCASE_RUN = /\b[A-ZÀ-Ý]{2,}(?:\s+[A-ZÀ-Ý]{2,})+\b|\b[A-ZÀ-Ý]{4,}\b/g;
const NAME_CUE = /^(?:estilo|tipo|como|igual|chamad\w*|camada)$/;

const REMOVAL_VERB = /^(?:tir\w*|retir\w*|remov\w*|apag\w*|elimin\w*|sem)$/;
const SWAP_VERB = /^(?:troc\w*|substitu\w*)$/;
const STOP_WORD = /^(?:para|pra|pro|pros|pras)$/;
const ACTION_VERB =
  /^(?:escrev\w*|coloc\w*|pint\w*|poe|ponha|bota|adicion\w*|inclu\w*|faz|fazer|faca)$/;
const PUT_VERB = /^(?:coloc\w*|poe|ponha|bota|adicion\w*|inclu\w*|pint\w*)$/;

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
  `\\b(?:atras|perto|acima|abaixo|ao lado|em volta)\\b(?:\\s+(?:d[aeo]s?))?\\s+${ARTICLE}$`,
);

interface Token {
  original: string;
  folded: string;
}

const tokenize = (text: string): Token[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((original) => ({
      original,
      folded: fold(original).replace(/^[^a-z0-9$%"“«]+|[^a-z0-9$%"”»]+$/g, ''),
    }));

const isNumeric = (word: string): boolean => /^[\d.,%]+$|^(?:reais|real|off)$/.test(word);
const opensQuote = (word: string): boolean => /^["“«]/.test(word) && !/["”»]$/.test(word.slice(1));

/** Marca o objeto de remoção: o verbo ou `sem` e até 3 palavras, parando em `para` ou em outro verbo, mais a forma que começou dentro. */
function removalMask(tokens: Token[]): boolean[] {
  const masked = tokens.map(() => false);
  tokens.forEach((token, start) => {
    if (!REMOVAL_VERB.test(token.folded)) return;
    masked[start] = true;
    let index = start + 1;
    let count = 0;
    while (index < tokens.length && count < 3) {
      const word = tokens[index].folded;
      if (STOP_WORD.test(word) || ACTION_VERB.test(word)) return;
      masked[index] = true;
      count += 1;
      index += 1;
    }
    let quoted = tokens.slice(start + 1, index).some((t) => opensQuote(t.original));
    while (index < tokens.length && (quoted || isNumeric(tokens[index].folded))) {
      masked[index] = true;
      if (quoted && /["”»]$/.test(tokens[index].original)) quoted = false;
      index += 1;
    }
  });
  return masked;
}

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

function looseTerm(rest: string): boolean {
  const folded = fold(rest);
  for (const match of folded.matchAll(LOOSE_TERM)) {
    const before = folded.slice(0, match.index ?? 0);
    if (RESERVE_BEFORE.test(before)) continue;
    if (PLACE_BEFORE.test(before) && !new RegExp(LOOSE_TERM).test(before)) continue;
    return true;
  }
  return false;
}

function classifyRest(rest: string, placing: boolean): PaintedVerdict {
  const folded = fold(rest);
  if (PRICE_FORM.test(folded)) return { level: 'refuse', kind: 'painted_price' };
  if (WRITE_VERB.test(folded) || WRITE_OBJECT.test(folded)) {
    return { level: 'refuse', kind: 'painted_text' };
  }
  const form = quotedForm(rest, placing);
  if (form === 'refuse') return { level: 'refuse', kind: 'painted_text' };
  if (form === 'doubt' || looseTerm(rest)) return { level: 'doubt', kind: null };
  return NONE;
}

function classifyClause(clause: string, field: PaintedField): PaintedVerdict {
  const tokens = tokenize(clause);
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
    );
  }
  const masked = removalMask(tokens);
  const rest = tokens
    .filter((_, i) => !masked[i])
    .map((t) => t.original)
    .join(' ');
  const placing = field === 'put' || tokens.some((t, i) => !masked[i] && PUT_VERB.test(t.folded));
  return classifyRest(rest, placing);
}

const RANK: Record<PaintedLevel, number> = { none: 0, doubt: 1, refuse: 2 };

/** Classifica o texto: o pior trecho vale. Preço antes de texto na recusa. */
export function classifyPainted(text: string, field: PaintedField): PaintedVerdict {
  let worst: PaintedVerdict = NONE;
  for (const [index, clause] of text.split(CLAUSE_SEPARATOR).entries()) {
    if (index % 2 === 1) continue;
    const verdict = classifyClause(clause, field);
    const better =
      RANK[verdict.level] > RANK[worst.level] ||
      (verdict.level === 'refuse' && worst.level === 'refuse' && verdict.kind === 'painted_price');
    if (better) worst = verdict;
  }
  return worst;
}
