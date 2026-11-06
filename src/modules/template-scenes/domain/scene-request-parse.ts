import { fold } from '../../../shared/text/fold';
import { LogoPosition, ParsedText } from './scene-layer.types';
import { detectZone } from './scene-request-text';

/** Texto entre aspas, texto depois de "escreve" e posição da logo no pedido (camadas exatas). */

const TEXT_VERB =
  /(escrev\w*|muda\w* o texto para|alter\w* o texto para|troc\w* o texto para|coloc\w* o texto|texto para|texto:)\s+/;
const PLACEMENT_TAIL = /\s+(embaixo|abaixo|em baixo|no rodape|em cima|acima|no topo)\b.*$/;

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

/** Posição pedida para a logo ("à esquerda no cabeçalho"); padrão: cabeçalho, à esquerda. */
export function logoPositionIn(folded: string): LogoPosition {
  const zone = detectZone(folded) ?? 'header';
  if (/\bdireita\b/.test(folded)) return { side: 'right', zone };
  if (/\b(centro|centraliz\w+)\b/.test(folded)) return { side: 'center', zone };
  return { side: 'left', zone };
}
