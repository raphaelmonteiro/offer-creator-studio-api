import { SceneElement, SceneZones } from './scene.types';

/**
 * O que mudou nas camadas, em pt-BR, pela diferença entre as camadas antes e depois (D-51, defeitos c e d): o chat só
 * relata mudança que aconteceu, e sem diferença diz que nada mudou. Nunca "Alterado apenas: texto 1".
 */

export interface LayerDiff {
  changed: boolean;
  /** A frase ao cliente: o que foi feito e onde, ou `null` se nada mudou. */
  text: string | null;
}

const SIDE_LABEL = { left: 'à esquerda', center: 'no centro', right: 'à direita' } as const;
const ZONE_LABEL = { header: 'no cabeçalho', body: 'no miolo', footer: 'no rodapé' } as const;

const sameBox = (a: SceneElement, b: SceneElement): boolean =>
  Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
const sameSize = (a: SceneElement, b: SceneElement): boolean =>
  Math.abs(a.w - b.w) < 1e-6 && (a.fontSize ?? 0) === (b.fontSize ?? 0);

/** "no rodapé, à direita": a zona pelo centro da camada e o lado pelo `x`. */
export function whereIs(element: SceneElement, zones: SceneZones): string {
  // No jornal o cabeçalho e o rodapé ocupam só uma metade da folha: o `x` também conta.
  const inHeader = element.y < zones.header.y + zones.header.h && element.x >= zones.header.x;
  const inFooter = element.y >= zones.footer.y && element.x <= zones.footer.x + zones.footer.w;
  const zone = inHeader ? 'header' : inFooter ? 'footer' : 'body';
  const side = element.x < 0.4 ? 'left' : element.x > 0.6 ? 'right' : 'center';
  return `${ZONE_LABEL[zone]}, ${SIDE_LABEL[side]}`;
}

/** "para o rodapé, à direita": o destino de um movimento leva "o" no lugar do "no" de `whereIs`. */
const whereTo = (element: SceneElement, zones: SceneZones): string =>
  whereIs(element, zones).replace(/^no /, 'o ');

const quoted = (text: string): string => `“${text}”`;

/** O que ficou claro da diferença entre antes e depois; vazio se as camadas são iguais. */
export function describeLayerDiff(
  before: SceneElement[],
  after: SceneElement[],
  zones: SceneZones,
): LayerDiff {
  const old = new Map(before.map((element) => [element.id, element]));
  const kept = new Set(after.map((element) => element.id));
  const sentences: string[] = [];
  for (const element of after) {
    const previous = old.get(element.id);
    if (!previous) {
      sentences.push(
        element.kind === 'text'
          ? `Coloquei a frase ${quoted(element.text ?? '')} como camada de texto ${whereIs(element, zones)}. Dá para arrastar e mudar fonte e cor no quadro.`
          : `Coloquei a camada ${quoted(element.name)} ${whereIs(element, zones)}.`,
      );
      continue;
    }
    if (element.kind === 'text' && element.text !== previous.text) {
      sentences.push(`Troquei o texto da camada para ${quoted(element.text ?? '')}.`);
    }
    if (!sameBox(element, previous)) {
      sentences.push(`Movi a camada ${quoted(element.name)} para ${whereTo(element, zones)}.`);
    }
    if (!sameSize(element, previous)) {
      sentences.push(`Mudei o tamanho da camada ${quoted(element.name)}.`);
    }
  }
  for (const element of before) {
    if (!kept.has(element.id)) sentences.push(`Tirei a camada ${quoted(element.name)}.`);
  }
  return sentences.length
    ? { changed: true, text: sentences.join(' ') }
    : { changed: false, text: null };
}

/** Sem diferença: a camada já está onde o cliente pediu. */
export function noLayerChangeText(target: SceneElement | null, zones: SceneZones): string {
  return target
    ? `A camada ${quoted(target.name)} já está ${whereIs(target, zones)}; nada mudou. Diga onde quer, ou arraste no quadro.`
    : 'Nenhuma camada mudou. Diga onde quer, ou arraste no quadro.';
}
