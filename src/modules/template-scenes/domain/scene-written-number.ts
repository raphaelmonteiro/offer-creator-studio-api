import { fold } from '../../../shared/text/fold';

/**
 * Detector único de ano, data e número escrito (D-42, validação 7), sobre os blocos em inglês e os pedidos em pt-BR.
 * Nenhum bloco de contexto pede número: o ano citado pelo cliente é contexto, e o número que ele quer ver escrito
 * vai só em `image.exact_text` (que não passa por aqui).
 *
 * Conta: ano (`19xx`, `20xx`), data (`12/04`, `12 de abril`, `April 12`, `12th of April`), "número" ou `number`
 * seguido de dígito e "indicação do ano", "da data", `the year`, `the date`. Não conta: quantidade ("3 coelhos"),
 * tema ("ano novo"), porcentagem, decimal e medida; fração simples (`1/3` seguida de `da`, `de`, `of` ou precedida de
 * `a`, `em`, `com`, `to`, `in`, `by`, R54); e, quando `removal` vale, o número que é objeto de remoção ou de troca
 * (R54, R55): depois de verbo de tirar ou trocar, antes de `por`, `with` ou `by`, inclusive no trecho herdado depois
 * de " e " ou " and ". Limite conhecido: "2000 ovos" é lido como ano.
 */

const MONTHS_PT =
  'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const MONTHS_EN =
  'january|february|march|april|may|june|july|august|september|october|november|december';
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';

const NUMBER_PATTERNS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}\b/,
  new RegExp(`\\b${DAY}\\s*\\/\\s*(?:0?[1-9]|1[0-2])(?:\\s*\\/\\s*\\d{2,4})?\\b`),
  new RegExp(`\\b${DAY}\\s+de\\s+(?:${MONTHS_PT})\\b`),
  new RegExp(`\\b(?:${MONTHS_EN})\\s+${DAY}(?:st|nd|rd|th)?\\b`),
  new RegExp(`\\b${DAY}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS_EN})\\b`),
  /\bnumeros?\s*(?:de\s+)?\d/,
  /\bnumbers?\s*(?:of\s+)?\d/,
  /\bindicacao\s+(?:do\s+ano|da\s+data|de\s+ano|de\s+data)\b/,
  /\bthe\s+(?:year|date)\b/,
];

/** Fração simples (R54): "ocupar 1/3 da imagem", "reduzir a 1/2", "to 1/4": não é data. */
const FRACTION =
  /\b(?:a|em|com|to|in|by)\s+(?:1\/[2-4]|2\/3|3\/4)\b|\b(?:1\/[2-4]|2\/3|3\/4)\s+(?:da|do|de|of)\b/g;

const REMOVAL =
  /\b(?:tir(?:a|ar|e|em|ei)|retir(?:a|ar|e|em)|remov(?:a|e|er|em)|apag(?:a|ar|ue|uem)|elimin(?:a|ar|e|em)|remove|removing|erase|delete|take out)\b/;
const TRADE = /\b(?:troc(?:a|ar|e|em)|substitu(?:i|a|ir|em)|replace|swap)\b/;
/** Verbo de pôr: o " e coloca 2027" depois de uma remoção é escrita nova, não objeto de remoção. */
const ADD_VERB =
  /\b(?:coloc\w*|adicion\w*|escrev\w*|pint(?:a|ar|e)|insir\w*|inser\w*|poe|pon\w*|desenh\w*|add|put|write|paint|insert|place|draw)\b/;
const TRADE_SPLIT = /\b(?:por|with|by)\b/;

export interface WrittenNumberOptions {
  /** O número que é objeto de remoção ou de troca não conta (`change`, `requests`, itens em aberto). */
  removal?: boolean;
}

/**
 * Cláusulas separadas por vírgula, ponto e vírgula, " e ", " and " ou ponto seguido de espaço; a vírgula entre
 * dígitos ("9,90") não separa.
 */
export const CLAUSE_SEPARATOR = /(\s*(?:(?<!\d),|,(?!\d)|;)\s*|\s+(?:e|and)\s+|\.\s+)/;

/** O separador que passa o contexto de remoção à cláusula seguinte (R55). */
const INHERITS = /^\s+(?:e|and)\s+$/;

const hasPattern = (folded: string): boolean => NUMBER_PATTERNS.some((p) => p.test(folded));

interface Clause {
  text: string;
  /** A cláusula traz número que conta. */
  counts: boolean;
  /** A cláusula é remoção ou troca, ou herdou isso: a seguinte, depois de " e ", também é. */
  removal: boolean;
}

function judge(clause: string, options: WrittenNumberOptions, inherited: boolean): Clause {
  const folded = fold(clause).replace(FRACTION, ' ');
  if (!options.removal) return { text: clause, counts: hasPattern(folded), removal: false };
  if (REMOVAL.test(folded) || (inherited && !ADD_VERB.test(folded)))
    return { text: clause, counts: false, removal: true };
  const trade = TRADE.exec(folded);
  if (trade) {
    // Troca: o número antes de "por"/"with"/"by" sai, o que vem depois é escrito.
    const after = folded.slice(trade.index).split(TRADE_SPLIT).slice(1).join(' ');
    return { text: clause, counts: hasPattern(after), removal: true };
  }
  return { text: clause, counts: hasPattern(folded), removal: false };
}

/** Cláusulas com os separadores entre elas; cada uma sabe se conta e se carrega contexto de remoção. */
function scan(text: string, options: WrittenNumberOptions) {
  const parts = text.split(CLAUSE_SEPARATOR);
  const clauses: Clause[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const inherited =
      index > 0 && INHERITS.test(parts[index - 1]) && clauses[clauses.length - 1].removal;
    clauses.push(judge(parts[index], options, inherited));
  }
  return { parts, clauses };
}

/** O texto traz ano, data ou número escrito? */
export function hasWrittenNumber(text: string, options: WrittenNumberOptions = {}): boolean {
  return scan(text, options).clauses.some((clause) => clause.counts);
}

/** Tira só o trecho que traz o número, até a vírgula, o ponto e vírgula, o " e " ou o " and " mais próximo. */
export function stripNumberClauses(text: string, options: WrittenNumberOptions = {}): string {
  const { parts, clauses } = scan(text, options);
  let out = '';
  clauses.forEach((clause, i) => {
    if (clause.counts) return;
    if (out) out += parts[i * 2 - 1] ?? ', ';
    out += clause.text;
  });
  return out.trim();
}
