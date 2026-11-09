import { RemovalReason } from './scene-reference.types';

/**
 * Termos que puxam conteúdo ou identidade para o template (D-1 inclui o selo e o medalhão da logo). Cada grupo vira um
 * motivo de remoção; a ordem é a de precedência quando um texto casa com mais de um grupo.
 */
const GROUPS: ReadonlyArray<[RemovalReason, string[]]> = [
  ['brand', ['logo', 'logotype', 'brand', 'marca', 'trademark', 'store name', 'nome da loja']],
  [
    'logo_badge',
    [
      'medallion',
      'medalhão',
      'medalhões',
      'medalha',
      'badge',
      'selo',
      'seal',
      'emblem',
      'emblema',
      'rosette',
      'roseta',
      'crest',
      'brasão',
      'brasões',
      'stamp',
      'carimbo',
      'insignia',
      'round frame',
      'moldura redonda',
    ],
  ],
  [
    'retail_symbol',
    [
      'cart',
      'shopping-cart',
      'shopping cart',
      'carrinho',
      'coin',
      'moeda',
      'currency',
      'cifrão',
      'price',
      'preço',
      'tag',
      'etiqueta',
      'discount',
      'desconto',
      'percent',
    ],
  ],
  [
    'content',
    [
      'photo',
      'photograph',
      'photography',
      'foto',
      'fotografia',
      'shelf',
      'shelves',
      'prateleira',
      'gôndola',
      'gondola',
      'collage',
      'colagem',
      'product',
      'produto',
      'food',
      'comida',
      'packaging',
      'embalagem',
      'bottle',
      'garrafa',
    ],
  ],
  [
    'text',
    [
      'lettering',
      'letters',
      'letra',
      'text',
      'texto',
      'title',
      'título',
      'word',
      'palavra',
      'slogan',
      'number',
      'número',
      'date',
      'data',
      'address',
      'endereço',
      'phone',
      'telefone',
      'whatsapp',
    ],
  ],
  [
    'people',
    [
      'person',
      'people',
      'pessoa',
      'model',
      'modelo',
      'face',
      'rosto',
      'mascot',
      'mascote',
      'character',
      'personagem',
    ],
  ],
  [
    'codes',
    [
      'qr',
      'barcode',
      'código de barras',
      'payment',
      'pagamento',
      'card logo',
      'bandeira de cartão',
      'social icon',
      'instagram',
      'facebook',
    ],
  ],
];

/** Símbolos sem fronteira de palavra: `$`, `R$` e `%` são de varejo. */
const SYMBOLS = /[$%]/;

const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fronteira de palavra com letras acentuadas (`\b` só conhece ASCII) e plural simples: "faceted" não é "face". */
const matcherOf = (terms: string[]): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${terms.map(escape).join('|')})(?:s|es)?(?![\\p{L}\\p{N}])`,
    'iu',
  );

const MATCHERS: ReadonlyArray<[RemovalReason, RegExp]> = GROUPS.map(([reason, terms]) => [
  reason,
  matcherOf(terms),
]);

/** O grupo do primeiro termo que o texto cita, ou `null`. */
export function termGroupOf(text: string): RemovalReason | null {
  for (const [reason, matcher] of MATCHERS) if (matcher.test(text)) return reason;
  return SYMBOLS.test(text) ? 'retail_symbol' : null;
}

/** A troca abstrata da rodada 1 do estudo: o que descreve conteúdo vira arte abstrata antes de qualquer corte. */
const ABSTRACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/(?:softly blurred\s+)?(?:supermarket[- ])?shelf photography/gi, 'warm blurred bokeh'],
  [/photographic collage/gi, 'soft layered color forms'],
  [/dimensional lettering/gi, 'abstract glossy 3D ornament'],
];

export const abstractTerms = (text: string): string =>
  ABSTRACTIONS.reduce((acc, [pattern, to]) => acc.replace(pattern, to), text);

/**
 * Campo livre: sai só a oração (trecho entre `,`, `;`, `.`, " with ", " and ") que tem o termo. Devolve o texto que
 * sobrou e as orações tiradas, com o motivo.
 */
export function dropSentencesWithTerms(text: string): {
  kept: string;
  dropped: Array<{ text: string; reason: RemovalReason }>;
} {
  const parts = abstractTerms(text).split(/(\s*[,;.]\s*|\s+with\s+|\s+and\s+)/i);
  const dropped: Array<{ text: string; reason: RemovalReason }> = [];
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const segment = parts[index];
    const reason = termGroupOf(segment);
    if (reason) {
      if (segment.trim()) dropped.push({ text: segment.trim(), reason });
      continue;
    }
    if (!segment.trim()) continue;
    const separator = kept.length > 0 ? (parts[index - 1] ?? ', ') : '';
    kept.push(`${separator}${segment.trim()}`);
  }
  return { kept: kept.join('').trim(), dropped };
}

/** Papel da cor que cita preço, produto ou seção: a cor é de bloco de seção, não do tema. */
export const SECTION_COLOR_ROLE =
  /(?<![\p{L}\p{N}])(?:price|product|section)(?:s)?(?![\p{L}\p{N}])/iu;
