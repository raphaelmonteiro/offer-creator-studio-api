import { fold } from '../../../shared/text/fold';

/**
 * Máscara do objeto de remoção (validação 4, R30, R38 a R40, R44): o que o plano manda tirar não é o que ele pede para
 * escrever. Depois de verbo de tirar o objeto vai até o fim do trecho; depois de `sem`, até 3 palavras e só a forma
 * que vem logo depois dele. Também reúne os verbos que o detector reconhece.
 */

const REMOVAL_VERB = /^(?:tir\w*|retir\w*|remov\w*|apag\w*|elimin\w*|sem)$/;
export const SWAP_VERB = /^(?:troc\w*|substitu\w*)$/;
/** Para a máscara de remoção: `para` abre outro pedido, e a referência de lugar fica de fora do que sai. */
const STOP_WORD = /^(?:para|pra|pro|pros|pras|atras|perto|acima|abaixo|junto)$/;
/** Verbo de escrita: a máscara de remoção para nele ("placa sem moldura escrita X"), salvo em "o que está escrito". */
const WRITE_STOP = /^(?:escrev\w*|escrit[oa]s?|dizendo)$/;
/** O que faz o particípio ficar no objeto: "o que está escrito", "sem nada escrito", "sem texto escrito". */
const COPULAR =
  /^(?:esta|estao|estiver|estava|foi|ficou|nada|nenhum|nenhuma|texto|textos|letras|palavra|palavras|frase|frases)$/;
const ARTICLE_WORD = /^(?:o|a|os|as|um|uma)$/;
export const TRUE_REMOVAL = /^(?:tir\w*|retir\w*|remov\w*|apag\w*|elimin\w*)$/;
/** Verbos de colocar que o Diretor usa (R44): "acrescentar", "inserir", "desenhar", "aplicar", "criar", "mostrar". */
const NEW_PUT_VERB =
  'acrescent\\w*|inser\\w*|desenh\\w*|aplic\\w*|mostr\\w*|cri(?:a|ar|e|em|o|ando)';
export const ACTION_VERB = new RegExp(
  `^(?:escrev\\w*|coloc\\w*|pint\\w*|poe|ponha|bota|adicion\\w*|inclu\\w*|faz|fazer|faca|${NEW_PUT_VERB})$`,
);
export const PUT_VERB = new RegExp(
  `^(?:coloc\\w*|poe|ponha|bota|adicion\\w*|inclu\\w*|pint\\w*|${NEW_PUT_VERB})$`,
);
export const INFINITIVE = /^[a-z]{3,}(?:ar|er|ir)$/;
/** Termo de escrita que pode vir entre `sem` e a forma: "sem o preço R$ 9,90" (R40). */
const WRITE_TERM = /^(?:precos?|palavras?|frases?|textos?|titulos?)$/;

export interface Token {
  original: string;
  folded: string;
}

export const tokenize = (text: string): Token[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((original) => ({
      original,
      folded: fold(original).replace(/^[^a-z0-9$%"“«]+|[^a-z0-9$%"”»]+$/g, ''),
    }));

const isNumeric = (word: string): boolean => /^[\d.,%]+$|^(?:reais|real|off)$/.test(word);
const opensQuote = (word: string): boolean => /^["“«]/.test(word) && !/["”»]$/.test(word.slice(1));

const isFormToken = (token: Token): boolean =>
  /\d/.test(token.original) ||
  /^["“«]/.test(token.original) ||
  /^r\$$/i.test(token.original) ||
  /^[A-ZÀ-Ý]{2,}[.,;!?]?$/.test(token.original) ||
  token.folded === 'off';

/**
 * Marca o objeto de remoção. Depois de verbo de tirar, o objeto vai até o fim do trecho: só `para`, referência de lugar
 * e verbo próprio de escrever ou colocar o param, e `com`, `escrit*` e o número de palavras não (R38, R39). Depois de
 * `sem`, até 3 palavras, parando também em `com` e nos verbos de escrita, e a forma só é objeto se vem logo depois dele
 * (R30, R40): "sem R$ 9,90" passa, e "selo sem borda 50% off" não.
 */
export function removalMask(tokens: Token[]): boolean[] {
  const masked = tokens.map(() => false);
  tokens.forEach((token, start) => {
    if (!REMOVAL_VERB.test(token.folded)) return;
    masked[start] = true;
    if (token.folded === 'sem') maskAfterWithout(tokens, masked, start);
    else maskAfterRemoval(tokens, masked, start);
  });
  return masked;
}

function maskAfterRemoval(tokens: Token[], masked: boolean[], start: number): void {
  for (let index = start + 1; index < tokens.length; index += 1) {
    const word = tokens[index].folded;
    if (STOP_WORD.test(word) || ACTION_VERB.test(word) || /^dizendo$/.test(word)) return;
    masked[index] = true;
  }
}

function maskAfterWithout(tokens: Token[], masked: boolean[], start: number): void {
  let index = start + 1;
  let count = 0;
  while (index < tokens.length && count < 3) {
    const word = tokens[index].folded;
    const writing = WRITE_STOP.test(word) && !COPULAR.test(tokens[index - 1].folded);
    if (word === 'com' || STOP_WORD.test(word) || ACTION_VERB.test(word) || writing) return;
    masked[index] = true;
    count += 1;
    index += 1;
  }
  // "sem nada escrito": o particípio depois de "nada" ou "texto" faz parte do objeto, ainda que passe das 3 palavras.
  if (
    index < tokens.length &&
    WRITE_STOP.test(tokens[index].folded) &&
    COPULAR.test(tokens[index - 1].folded)
  ) {
    masked[index] = true;
    index += 1;
  }
  let quoted = tokens.slice(start + 1, index).some((t) => opensQuote(t.original));
  while (index < tokens.length && (quoted || isNumeric(tokens[index].folded))) {
    masked[index] = true;
    if (quoted && /["”»]$/.test(tokens[index].original)) quoted = false;
    index += 1;
  }
  unmaskLateForm(tokens, masked, start, index);
}

/** Com `sem`, a forma que não vem logo depois dele (só artigo e termo de escrita no meio) não é o objeto. */
function unmaskLateForm(tokens: Token[], masked: boolean[], start: number, end: number): void {
  for (let j = start + 1; j < end; j += 1) {
    if (!isFormToken(tokens[j])) continue;
    const direct = tokens
      .slice(start + 1, j)
      .every((t) => ARTICLE_WORD.test(t.folded) || WRITE_TERM.test(t.folded));
    if (!direct) for (let k = j; k < end; k += 1) masked[k] = false;
    return;
  }
}
