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

/** Zona nomeada do encarte, pelos sinônimos de `detectZone` do protótipo. */
export function detectZone(text: string): SceneZoneName | null {
  const f = fold(text);
  if (/(cabecalho|header|\btopo\b)/.test(f)) return 'header';
  if (/(miolo|\bcorpo\b|\bmeio\b)/.test(f)) return 'body';
  if (/(rodape|footer|\bbase\b)/.test(f)) return 'footer';
  return null;
}

/** O pedido cita um item da imagem (artigo + substantivo que não seja da imagem inteira)? */
export function citesImageItem(folded: string): boolean {
  for (const match of folded.matchAll(ARTICLE_NOUN)) {
    if (!GLOBAL_WORDS.has(match[2])) return true;
  }
  return false;
}

/** "Adicionar X": verbo forte, ou "colocar um(a) X" sem trocar e sem citar um item que já existe. */
export function wantsAddition(folded: string): boolean {
  if (SWAP_WORDS.test(folded)) return false;
  if (ADD_STRONG.test(folded)) return true;
  return (
    ADD_SOFT.test(folded) &&
    INDEFINITE.test(folded) &&
    !/\b(no|na|nos|nas)\s+[a-z]{3,}/.test(folded)
  );
}

/** O que se quer adicionar ("um balão de ar quente" → "balão de ar quente"). */
export function additionSubject(original: string): string {
  const cleaned = original
    .replace(
      /^.*?\b(adicion\w+|acrescent\w+|inclu\w+|insir\w+|insere|coloc\w+|po(?:e|nha)|bota\w*)\s+/i,
      '',
    )
    .replace(/^(um|uma|uns|umas|o|a)\s+/i, '')
    .trim();
  return cleaned.replace(/[.!]+$/, '') || original.trim();
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

/** Texto entre aspas, ou depois de "escreve"/"muda o texto para"; `null` se o pedido não traz texto. */
export function parseText(original: string): ParsedText | null {
  const folded = fold(original);
  const quoted = original.match(/["“«]([^"”»]+)["”»]/);
  const verb = folded.match(TEXT_VERB);
  if (!quoted && !verb) return null;
  let content: string;
  let tailSource: string;
  if (quoted) {
    content = quoted[1];
    tailSource = folded.slice((quoted.index ?? 0) + quoted[0].length);
  } else {
    content = original.slice((verb?.index ?? 0) + (verb?.[0].length ?? 0));
    const tail = fold(content).match(PLACEMENT_TAIL);
    tailSource = tail ? tail[0] : '';
    if (tail) content = content.slice(0, tail.index);
  }
  const text = content
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/^["“«]+|["”»]+$/g, '')
    .trim();
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
