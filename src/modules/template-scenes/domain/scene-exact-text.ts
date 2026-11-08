import { fold } from '../../../shared/text/fold';
import { DirectorImage } from './scene-director-schema';

/**
 * Validações 4a e 4b (D-51, G3): o texto que vai ao modelo de imagem foi escrito pelo cliente, e não há texto
 * escondido fora do bloco de texto exato. Nenhuma das duas recusa pedido de escrita: falhando, o Diretor é refeito
 * uma vez; persistindo, 4a pergunta o texto exato e 4b tira só o trecho. Texto de camada não é fonte: só mensagens
 * do cliente e o texto já pintado e conferido da versão atual (`metrics.paintedText`).
 */

export interface TextSources {
  /** Todas as mensagens do cliente (a atual e as do contexto), literais. */
  clientMessages: string[];
  /** Linhas pintadas a pedido e conferidas na versão atual. */
  paintedText: string[];
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Aspas retas, tipográficas e francesas. */
const QUOTED = /"[^"]*"|“[^”]*”|«[^»]*»/g;
const QUOTED_CAPTURE = /"([^"]*)"|“([^”]*)”|«([^»]*)»/g;

/** A mensagem sem os trechos entre aspas (cada um vira um separador que nenhuma linha contém). */
const outsideQuotes = (message: string): string => message.replace(QUOTED, ' | ');

/** Palavras e números (`19,90` é um só); `R$` entra como a letra `R`. Comparação literal, com acento e caixa. */
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+/gu;
const tokensOf = (text: string): string[] => text.match(TOKEN) ?? [];

function allWordsKnown(line: string, sources: TextSources): boolean {
  const known = new Set([...sources.clientMessages, ...sources.paintedText].flatMap(tokensOf));
  const tokens = tokensOf(line);
  return tokens.length > 0 && tokens.every((token) => known.has(token));
}

/**
 * O Diretor às vezes devolve a linha já entre aspas (`“Fechado”`, `"boa páscoa"`): as aspas são dele, não do texto.
 * Tira um par de aspas que envolve a linha inteira, retas, tipográficas ou francesas (medida 1.59).
 */
export function unquoteLine(line: string): string {
  const text = line.trim();
  const pair = /^(?:"([^"]*)"|“([^”]*)”|«([^»]*)»)$/.exec(text);
  return pair ? (pair[1] ?? pair[2] ?? pair[3]).trim() : text;
}

/** Uma linha de `exact_text` é aceita (validação 4a)? */
export function exactLineAllowed(line: string, sources: TextSources): boolean {
  const text = collapse(line);
  if (!text) return false;
  if (sources.clientMessages.some((message) => collapse(message).includes(text))) return true;
  // D-53: só acento, cedilha e caixa mudam, e o trecho original fica fora de aspas.
  const folded = fold(text);
  if (sources.clientMessages.some((m) => collapse(fold(outsideQuotes(m))).includes(folded))) {
    return true;
  }
  return allWordsKnown(text, sources);
}

export type ExactTextCheck = { ok: true } | { ok: false; reason: string };

export const EXACT_TEXT_RETRY_REASON =
  'image.exact_text tem texto que o cliente não escreveu: copie a linha da mensagem do cliente (entre aspas, exatamente igual; sem aspas, só acento, cedilha e maiúsculas podem mudar) ou deixe exact_text vazio';

/** Validação 4a: toda linha de `exact_text` vem das mensagens do cliente ou do texto já pintado. */
export function checkExactText(lines: string[], sources: TextSources): ExactTextCheck {
  const bad = lines.find((line) => !exactLineAllowed(line, sources));
  return bad === undefined
    ? { ok: true }
    : { ok: false, reason: `${EXACT_TEXT_RETRY_REASON} ("${bad}")` };
}

/** Preço: `R$` com valor, valor com "reais", `% off` e `% de desconto`. Decimal solto não é preço (R50). */
const PRICE = /R\$\s*\d[\d.,]*|\d[\d.,]*\s*reais\b|\d+\s*%\s*(?:off\b|de desconto)/gi;

type TextField = 'composition' | 'style' | 'change';
const FIELDS: readonly TextField[] = ['composition', 'style', 'change'];

interface Span {
  start: number;
  end: number;
}

/** Trechos entre aspas e preços de um texto que não estão literais em nenhuma fonte permitida. */
function offendingSpans(text: string, allowed: string): Span[] {
  const spans: Span[] = [];
  const known = collapse(allowed);
  const knownFolded = fold(known);
  for (const match of text.matchAll(QUOTED_CAPTURE)) {
    const content = collapse(match[1] ?? match[2] ?? match[3] ?? '');
    if (!known.includes(content)) {
      spans.push({ start: match.index as number, end: (match.index as number) + match[0].length });
    }
  }
  for (const match of text.matchAll(PRICE)) {
    if (!knownFolded.includes(fold(collapse(match[0])))) {
      spans.push({ start: match.index as number, end: (match.index as number) + match[0].length });
    }
  }
  // Preço dentro de um trecho entre aspas já é cortado com ele: sem sobreposição.
  const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return sorted.filter((span, index) => !sorted.slice(0, index).some((o) => o.end >= span.end));
}

/** O que o cliente escreveu, o que vai no bloco exato e o que já está pintado: tudo o que pode ser citado. */
function allowedText(image: DirectorImage, sources: TextSources): string {
  return [...sources.clientMessages, ...image.exact_text, ...sources.paintedText].join(' \n ');
}

const blocks = (image: DirectorImage): string[] => [
  ...FIELDS.map((field) => image[field]),
  ...image.preserve,
];

export const OUTSIDE_TEXT_RETRY_REASON =
  'o texto a pintar vai só em image.exact_text; composition, style, change e preserve não levam aspas nem preço que o cliente não escreveu; para citar texto que já existe na imagem e o cliente não escreveu, descreva sem aspas ("the existing sign lettering")';

/** Validação 4b: aspas ou preço fora do bloco exato, que não vêm das mensagens, de `exact_text` nem do já pintado. */
export function checkTextOutsideBlock(image: DirectorImage, sources: TextSources): ExactTextCheck {
  const allowed = allowedText(image, sources);
  return blocks(image).some((text) => offendingSpans(text, allowed).length > 0)
    ? { ok: false, reason: OUTSIDE_TEXT_RETRY_REASON }
    : { ok: true };
}

/** Palavra que introduz o trecho tirado ("reading", "saying", "with the text", "escrito"), junto com ele. */
const INTRODUCER =
  /\s*(?:\b(?:reading|saying|that says|that reads|which says|with the (?:text|words|phrase)|written|escrit[oa]|dizendo|com (?:o texto|a frase))\b)\s*[:,]?\s*$/i;

function stripSpans(text: string, spans: Span[]): string {
  let out = text;
  for (const span of [...spans].reverse()) {
    out = out.slice(0, span.start).replace(INTRODUCER, '') + out.slice(span.end);
  }
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}

export interface TextPatch {
  field: string;
  before: string;
  after: string;
}

/** Persistindo a violação de 4b, tira só o trecho (e o que o introduz), mantém o resto e devolve o que cortou. */
export function stripTextOutsideBlock(
  image: DirectorImage,
  sources: TextSources,
): { image: DirectorImage; patches: TextPatch[] } {
  const allowed = allowedText(image, sources);
  const patches: TextPatch[] = [];
  const next: DirectorImage = { ...image, preserve: [...image.preserve] };
  const strip = (field: string, text: string): string => {
    const spans = offendingSpans(text, allowed);
    if (spans.length === 0) return text;
    const after = stripSpans(text, spans);
    patches.push({ field, before: text, after });
    return after;
  };
  for (const field of FIELDS) next[field] = strip(field, image[field]);
  next.preserve = image.preserve
    .map((item, index) => strip(`preserve.${index}`, item))
    .filter((item) => item.trim());
  return { image: next, patches };
}
