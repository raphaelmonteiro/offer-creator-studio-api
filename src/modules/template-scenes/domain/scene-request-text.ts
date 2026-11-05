import { SceneZoneName } from './scene.types';

/**
 * Leitura do texto do pedido por palavra-chave (sem IA), usada pelo classificador. Tudo roda sobre o
 * texto "dobrado" (minúsculo, sem acento, mesmo comprimento do original, para os índices
 * coincidirem). Verbos valem por palavra inteira: "remover" nunca casa com "mover".
 */

/** Minúsculo e sem acento, caractere a caractere (o comprimento não muda). */
export const fold = (text: string): string =>
  Array.from(text.normalize('NFC'))
    .map((ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())
    .join('');

export type LayerKind = 'logo' | 'text';
export type Side = 'left' | 'right' | 'toggle';

const MOVE_WORDS = /\b(mov(er|e|a|am|endo)|desloc\w+|movimenta\w*)\b/;
const MOVE_SIDE =
  /\b(troc\w*|invert\w*|mud\w*)\b.*\b(de lado|outro lado|lado)\b|\b(de lado|outro lado)\b/;
const MOVE_TO_DIRECTION =
  /\b(lev(a|ar|e)|pass(a|ar|e)|coloc(a|ar|e)|po(e|nha)|joga\w*)\b.*\bpara\b.*\b(esquerda|direita|centro|cima|baixo|frente|lado)\b/;
const RESIZE_UP = /\b(maior|aument\w+|cresc\w+|grande)\b/;
const RESIZE_DOWN = /\b(menor|diminu\w+|reduz\w*|pequen\w+)\b/;
const REMOVE_WORDS = /\b(remov\w+|tir(a|ar|e)|apag\w+|delet\w+|exclu\w+)\b/;
const ADD_STRONG = /\b(adicion\w+|acrescent\w+|inclu(i|ir|a)|insir\w+|insere)\b/;
const ADD_SOFT = /\b(coloc(a|ar|e)|po(e|nha)|bota\w*)\b/;
const INDEFINITE = /\b(um|uma|uns|umas)\b/;
const SWAP_WORDS = /\b(troc\w+|substitu\w+|mud\w+|alter\w+|transform\w+)\b/;
const LOGO_NOUN = /\b(logo|logotipo|logomarca)\b/;
const TEXT_NOUN = /\b(texto|titulo|frase|legenda|slogan)\b/;
const TEXT_VERB =
  /(escrev\w*|muda\w* o texto para|alter\w* o texto para|troc\w* o texto para|coloc\w* o texto|texto para|texto:)\s+/;
const PLACEMENT_TAIL = /\s+(embaixo|abaixo|em baixo|no rodape|em cima|acima|no topo)\b.*$/;

/** Palavras que, depois de artigo, falam da imagem inteira e não de um item dela. */
const GLOBAL_WORDS = new Set([
  'tudo',
  'todo',
  'toda',
  'todos',
  'todas',
  'imagem',
  'imagens',
  'cena',
  'fundo',
  'fundos',
  'cor',
  'cores',
  'tom',
  'tons',
  'estilo',
  'clima',
  'visual',
  'aparencia',
  'luz',
  'luzes',
  'iluminacao',
  'paleta',
  'atmosfera',
  'resto',
  'geral',
  'qualidade',
  'foto',
  'arte',
  'desenho',
  'ilustracao',
  'contraste',
  'saturacao',
  'brilho',
  'pedido',
  'mesmo',
  'mesma',
  'outro',
  'outra',
  'mais',
  'menos',
  'muito',
  'pouco',
  'seguinte',
  'novo',
  'nova',
  // zonas e palavras de composição: falam da imagem, não de um item dela (correção 1)
  'cabecalho',
  'header',
  'topo',
  'miolo',
  'corpo',
  'meio',
  'body',
  'rodape',
  'footer',
  'base',
  'divisao',
  'transicao',
  'harmonia',
  'diferente',
  'diferentes',
  'igual',
  'iguais',
  'parecido',
  'parecida',
  'estranho',
  'errado',
]);
const ARTICLE_NOUN =
  /\b(o|a|os|as|um|uma|uns|umas|do|da|dos|das|no|na|nos|nas|ao|aos|pelo|pela|esse|essa|esses|essas|este|esta|aquele|aquela)\s+([a-z]{3,})/g;

export function mentionsMove(folded: string): boolean {
  return MOVE_WORDS.test(folded) || MOVE_SIDE.test(folded) || MOVE_TO_DIRECTION.test(folded);
}

export const mentionsResize = (folded: string): 'bigger' | 'smaller' | null =>
  RESIZE_UP.test(folded) ? 'bigger' : RESIZE_DOWN.test(folded) ? 'smaller' : null;

export const mentionsRemove = (folded: string): boolean => REMOVE_WORDS.test(folded);

/** Logo ou texto citado pelo nome (a marca "marca" não conta: "marca a área" é outro pedido). */
export function layerKindIn(folded: string): LayerKind | null {
  if (LOGO_NOUN.test(folded)) return 'logo';
  return TEXT_NOUN.test(folded) ? 'text' : null;
}

/** Lado do pedido de mover; sem lado claro, alterna. */
export function sideIn(folded: string): Side {
  if (/\besquerda\b/.test(folded)) return 'left';
  if (/\bdireita\b/.test(folded)) return 'right';
  return 'toggle';
}

const ZONE_WORDS: Record<SceneZoneName, string> = {
  header: 'cabecalho|header|topo',
  body: 'miolo|corpo|meio|body',
  footer: 'rodape|footer|base',
};

/** Zona nomeada do encarte, pelos sinônimos de `detectZone` do protótipo (em qualquer posição do texto). */
export function detectZone(text: string): SceneZoneName | null {
  const f = fold(text);
  for (const zone of ['header', 'body', 'footer'] as const) {
    if (new RegExp(`\\b(${ZONE_WORDS[zone]})\\b`).test(f)) return zone;
  }
  return null;
}

const ZONE_AS_PLACE = new RegExp(
  `\\b(no|na|nos|nas|em|ao|para|do|da|dos|das)\\s+(?:(?:o|a|os|as)\\s+)?(${Object.values(ZONE_WORDS).join('|')})\\b`,
  'g',
);
/** Zona como objeto de um pedido no imperativo ("deixa o rodapé mais escuro"); o passado é reclamação. */
const ZONE_AFTER_COMMAND = new RegExp(
  `\\b(deix(?:a|e|ar)|faz|fa[cz]a|fazer|mud(?:a|e|ar)|troc(?:a|ue|ar)|escurec(?:e|a|er)|clare(?:ia|ie|ar)|ilumin(?:a|e|ar)|suaviz(?:a|e|ar)|limp(?:a|e|ar))\\s+(?:(?:o|a|os|as)\\s+)?(${Object.values(ZONE_WORDS).join('|')})\\b`,
);

/** "diferente do body", "igual ao header": a zona é termo de comparação, não o lugar do pedido. */
const COMPARISON_WORDS =
  /^(diferente|diferentes|igual|iguais|parecido|parecida|parecidos|parecidas)$/;

/**
 * Zona citada no texto **como lugar** (correção 1): precedida de "no/na/nos/nas/em/ao/para o/para a",
 * ou de "do/da" (salvo depois de "diferente", "igual" ou "parecido"). Sujeito de reclamação ("o header
 * está", "mudou o cabeçalho") não vale. O campo `zone` do pedido continua valendo sempre.
 */
export function zoneAsPlace(text: string): SceneZoneName | null {
  const f = fold(text);
  for (const match of f.matchAll(ZONE_AS_PLACE)) {
    const before = f.slice(0, match.index).trim().split(/\s+/).pop() ?? '';
    if (!COMPARISON_WORDS.test(before)) return zoneOfWord(match[2]);
  }
  const command = f.match(ZONE_AFTER_COMMAND);
  return command ? zoneOfWord(command[2]) : null;
}

function zoneOfWord(word: string): SceneZoneName | null {
  const zones = ['header', 'body', 'footer'] as const;
  return zones.find((zone) => new RegExp(`^(${ZONE_WORDS[zone]})$`).test(word)) ?? null;
}

/** O pedido cita um item da imagem (artigo + substantivo que não seja da imagem inteira)? */
export function citesImageItem(folded: string): boolean {
  for (const match of folded.matchAll(ARTICLE_NOUN)) {
    if (!GLOBAL_WORDS.has(match[2])) return true;
  }
  return false;
}

/** Palavras que apontam a marcação, e não um objeto ("remove essa área", "tira o que está aqui"). */
const POINTER_WORDS = new Set([
  'area',
  'regiao',
  'marcada',
  'marcacao',
  'selecao',
  'selecionada',
  'coisa',
  'item',
  'objeto',
  'trecho',
  'que',
  'aqui',
  'ali',
]);

/** O pedido de remover nomeia o que sai ("os ovos"), ou só aponta ("isso", "essa área")? */
export function namesObject(folded: string): boolean {
  for (const match of folded.matchAll(ARTICLE_NOUN)) {
    if (!GLOBAL_WORDS.has(match[2]) && !POINTER_WORDS.has(match[2])) return true;
  }
  return false;
}

/**
 * "Adicionar X": verbo forte, ou "colocar um(a) X" sem trocar, sem citar um item que já existe e
 * sem área marcada (D-15: com área, "colocar/pôr" é edição local).
 */
export function wantsAddition(folded: string, hasArea = false): boolean {
  if (SWAP_WORDS.test(folded)) return false;
  if (ADD_STRONG.test(folded)) return true;
  return (
    !hasArea &&
    ADD_SOFT.test(folded) &&
    INDEFINITE.test(folded) &&
    !/\b(no|na|nos|nas)\s+[a-z]{3,}/.test(folded)
  );
}

const NEW_IMAGE_QUALIFIER =
  /\b(ger\w*|cri\w*|faz\w*|fac\w+|mont\w+)\b.{0,40}\b(outra|outro|nova|novo|segunda|terceira|mais uma)\s+(imagem|arte|fundo|versao|cena|template|opcao|variacao)\b/;
const NEW_IMAGE_GENERATE = /\b(ger(a|e|ar)|cri(a|e|ar))\s+(outra|nova|mais uma)\b/;
const NEW_IMAGE_FROM_ZERO =
  /\b(refaz\w*|refaca|comec\w+|recomec\w+)\b.{0,30}\b(zero|inicio|tudo)\b/;
const NEW_IMAGE_REPLACE = /\bsubstitu\w+\s+(essa|esta)\s*(imagem|arte|cena|,|\.|$|pois|porque|que)/;
const CHANGE_ALL_UNSPECIFIED =
  /\b(mud\w+|troc\w+|refac\w+|refaz\w*|alter\w+)\s+tudo\b(?!\s+(para|pra|em|de|com|por|tons?|cores?|mais|menos))/;

/**
 * Pede outra imagem do zero (D-18): "gerar/criar/fazer" com "outra/nova/segunda/mais uma", "refazer ou
 * começar do zero", "substituir essa", ou "mude/troque/refaça tudo" sem dizer como.
 */
export function wantsNewImage(folded: string): boolean {
  return (
    NEW_IMAGE_QUALIFIER.test(folded) ||
    NEW_IMAGE_GENERATE.test(folded) ||
    NEW_IMAGE_FROM_ZERO.test(folded) ||
    NEW_IMAGE_REPLACE.test(folded) ||
    CHANGE_ALL_UNSPECIFIED.test(folded)
  );
}

const INTEGRATE_WORDS = /\b(integr\w+|incorpor\w+|fund(a|ir|e)|mescl\w+)\b/;

/** "Integrar" uma camada ao fundo (correção 5). */
export const mentionsIntegrate = (folded: string): boolean => INTEGRATE_WORDS.test(folded);

const PLACE_OF_ITEM =
  /\b(no lugar d[aoe]s?|em vez d[aoe]s?|ao inves d[aoe]s?|onde (estava|ficava|tinha))\b/;

/** "no lugar de X", "em vez de X", "onde estava X": X não se localiza, então não há posição a inventar. */
export const mentionsPlaceOfItem = (folded: string): boolean => PLACE_OF_ITEM.test(folded);

const PLACE_OF_ITEM_TAIL =
  /\s+(?:no lugar|em vez|ao inv[eé]s|onde\s+(?:estava|ficava|tinha))\b.*$/i;

/** "no cabeçalho", "na base da imagem": a citação da zona não faz parte do assunto (D-14). */
const ZONE_PHRASE =
  /\s+(?:n[oa]s?|em|ao|para\s+[oa])\s+(?:[oa]\s+)?(?:cabe[cç]alho|header|topo|miolo|corpo|meio|rodap[eé]|footer|base)(?![a-zà-ÿ])(?:\s+d[aoe]s?\s+(?:imagem|arte|encarte|cena|folheto))?/i;

/** O que se quer adicionar ("um balão de ar quente" → "balão de ar quente"). */
export function additionSubject(original: string): string {
  const cleaned = original
    .replace(
      /^.*?\b(adicion\w+|acrescent\w+|inclu\w+|insir\w+|insere|coloc\w+|po(?:e|nha)|bota\w*)\s+/i,
      '',
    )
    .replace(/^(um|uma|uns|umas|o|a)\s+/i, '')
    .trim();
  const subject = cleaned
    .replace(PLACE_OF_ITEM_TAIL, '')
    .replace(ZONE_PHRASE, '')
    .replace(/[.!]+$/, '')
    .trim();
  return subject || cleaned.replace(/[.!]+$/, '') || original.trim();
}

export interface ParsedText {
  text: string;
  placement: 'below-logo' | 'top' | 'bottom' | 'none';
  /** "muda o texto para ...": troca o texto existente em vez de criar outro. */
  replace: boolean;
}

function placementOf(tail: string): ParsedText['placement'] {
  if (/(embaixo|abaixo|em baixo)/.test(tail) && /(logo|dela|dele)/.test(tail)) return 'below-logo';
  if (/(em cima|acima|topo)/.test(tail)) return 'top';
  return tail ? 'bottom' : 'none';
}

/** Conteúdo e trecho final (para a posição) de um texto entre aspas. */
function quotedParts(
  folded: string,
  quoted: RegExpMatchArray,
): { content: string; tailSource: string } {
  return {
    content: quoted[1],
    tailSource: folded.slice((quoted.index ?? 0) + quoted[0].length),
  };
}

/** Conteúdo e trecho final (para a posição) de um texto que vem depois do verbo ("escreve ..."). */
function afterVerbParts(
  original: string,
  verb: RegExpMatchArray,
): { content: string; tailSource: string } {
  const content = original.slice((verb.index ?? 0) + verb[0].length);
  const tail = fold(content).match(PLACEMENT_TAIL);
  if (!tail) return { content, tailSource: '' };
  return { content: content.slice(0, tail.index), tailSource: tail[0] };
}

const cleanText = (content: string): string =>
  content
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/^["“«]+|["”»]+$/g, '')
    .trim();

/** Texto entre aspas, ou depois de "escreve"/"muda o texto para"; `null` se o pedido não traz texto. */
export function parseText(original: string): ParsedText | null {
  const folded = fold(original);
  const quoted = original.match(/["“«]([^"”»]+)["”»]/);
  const verb = folded.match(TEXT_VERB);
  if (!quoted && !verb) return null;
  const { content, tailSource } = quoted
    ? quotedParts(folded, quoted)
    : afterVerbParts(original, verb as RegExpMatchArray);
  const text = cleanText(content);
  if (!text) return null;
  const replace = !quoted && /(muda|alter|troc|texto para|texto:)/.test(verb?.[0] ?? '');
  return { text, placement: placementOf(tailSource), replace };
}

export interface LogoPosition {
  side: 'left' | 'center' | 'right';
  zone: SceneZoneName;
}

/** Posição pedida para a logo ("à esquerda no cabeçalho"); padrão: cabeçalho, à esquerda. */
export function logoPositionIn(folded: string): LogoPosition {
  const zone = detectZone(folded) ?? 'header';
  if (/\bdireita\b/.test(folded)) return { side: 'right', zone };
  if (/\b(centro|centraliz\w+)\b/.test(folded)) return { side: 'center', zone };
  return { side: 'left', zone };
}
