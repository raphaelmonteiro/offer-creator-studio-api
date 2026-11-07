import { fold } from '../../../shared/text/fold';
import { FUNCTION_WORDS } from './scene-words';

/**
 * Detector único de ano, data e número escrito (D-42, validação 7). Nenhum prompt de imagem pede número: o ano
 * citado pelo cliente é contexto, e o número escrito só vale como camada de texto exata.
 *
 * Conta: ano (`19xx`, `20xx`), data (`12/04`, `12 de abril`), "número" seguido de dígito e "indicação do ano" ou
 * "da data". Não conta: quantidade ("3 coelhos"), tema ("ano novo") e, quando `removal` vale, a cláusula que
 * pede para tirar ("tira o 2027"). Limite conhecido: "2000 ovos" é lido como ano.
 */

const MONTHS =
  'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
const NUMBER_PATTERNS: readonly RegExp[] = [
  /\b(?:19|20)\d{2}\b/,
  /\b(?:0?[1-9]|[12]\d|3[01])\s*\/\s*(?:0?[1-9]|1[0-2])(?:\s*\/\s*\d{2,4})?\b/,
  new RegExp(`\\b(?:0?[1-9]|[12]\\d|3[01])\\s+de\\s+(?:${MONTHS})\\b`),
  /\bnumeros?\s*(?:de\s+)?\d/,
  /\bindicacao\s+(?:do\s+ano|da\s+data|de\s+ano|de\s+data)\b/,
];
const REMOVAL =
  /\b(?:tir(?:a|ar|e|em|ei)|retir(?:a|ar|e|em)|remov(?:a|e|er|em)|apag(?:a|ar|ue|uem)|elimin(?:a|ar|e|em))\b/;

/** Palavras que, sozinhas com o número, mostram que o cliente pediu o número ("2027 em cima"). */
const POSITION_AND_FILLER = new Set([
  'ano',
  'data',
  'numero',
  'numeros',
  'indicacao',
  'cima',
  'baixo',
  'embaixo',
  'acima',
  'abaixo',
  'topo',
  'canto',
  'centro',
  'meio',
  'direita',
  'esquerda',
  'lado',
  'parte',
  'superior',
  'inferior',
  'rodape',
  'cabecalho',
  'coloca',
  'colocar',
  'poe',
  'por',
]);

export interface WrittenNumberOptions {
  /** A cláusula que pede para tirar o número não conta (`what_to_change`, `requests`, itens em aberto). */
  removal?: boolean;
}

/** Cláusulas separadas por vírgula, ponto e vírgula, " e " ou ponto seguido de espaço; a vírgula entre dígitos ("9,90") não separa. */
export const CLAUSE_SEPARATOR = /(\s*(?:(?<!\d),|,(?!\d)|;)\s*|\s+e\s+|\.\s+)/;

const hasNumber = (clause: string, options: WrittenNumberOptions): boolean => {
  const folded = fold(clause);
  if (options.removal && REMOVAL.test(folded)) return false;
  return NUMBER_PATTERNS.some((pattern) => pattern.test(folded));
};

/** O texto traz ano, data ou número escrito? */
export function hasWrittenNumber(text: string, options: WrittenNumberOptions = {}): boolean {
  return text
    .split(CLAUSE_SEPARATOR)
    .some((part, index) => index % 2 === 0 && hasNumber(part, options));
}

/** Tira só o trecho que traz o número, até a vírgula, o ponto e vírgula ou o " e " mais próximo. */
export function stripNumberClauses(text: string, options: WrittenNumberOptions = {}): string {
  const parts = text.split(CLAUSE_SEPARATOR);
  let out = '';
  for (let index = 0; index < parts.length; index += 2) {
    if (hasNumber(parts[index], options)) continue;
    if (out) out += parts[index - 1] ?? ', ';
    out += parts[index];
  }
  return out.trim();
}

/** Deslocamento: porcentagem, decimal ou dígito seguido de direção ("20% para a direita", "1,50 acima"; R42). */
const DISPLACEMENT =
  /%|\d[.,]\d|\d+\s+(?:para\s+|pra\s+)?(?:cima|baixo|acima|abaixo|(?:a\s+)?(?:direita|esquerda))\b/;

/** Só sobra o número, posição e palavras de ligação ("2027 em cima"): o cliente pediu o número. */
export function onlyNumberLeft(text: string): boolean {
  const written = hasWrittenNumber(text);
  // Dígitos soltos contam ('99 no canto'), mesmo sem ser ano nem data (R34); '3 coelhos' tem palavra sobrando.
  if (!written && !/\d/.test(text)) return false;
  // O número que desloca algo não é o número pedido (R42); ano e data valem em qualquer posição.
  if (!written && DISPLACEMENT.test(fold(text))) return false;
  const words = fold(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((word) => !/\d/.test(word) && !MONTHS.split('|').includes(word))
    .filter((word) => !FUNCTION_WORDS.has(word) && !POSITION_AND_FILLER.has(word));
  return words.length === 0;
}
