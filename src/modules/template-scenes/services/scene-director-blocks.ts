import { BriefItem } from '../domain/scene-brief';
import { FaceKey, hasZone } from '../domain/scene-faces';
import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { maskBounds } from '../domain/scene-mask-shape';
import { PaintedLine, readPaintedLines } from '../domain/scene-painted-text';
import { MaskShape, Rect, SceneElement, SceneZones } from '../domain/scene.types';
import { zoneBands } from '../domain/scene-zone-bands';
import { tabloidFormatBlock } from '../domain/scene-director-tabloid';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { DisplayedVersion } from './scene-display-number';

/** Os blocos de texto do contexto do Diretor (D-23): histórico, pedidos, versões, formato, texto pintado e marcação. */

/** As linhas pintadas da versão (`metrics.paintedText`), com zona e marca; vazio em versão sem texto pintado. */
export const paintedLinesOf = (
  version: Pick<TemplateSceneVersion, 'metrics'> | null,
): PaintedLine[] => readPaintedLines(version?.metrics?.paintedText);

/** O texto de cada linha pintada da versão: fonte das validações 4 e 7. */
export const paintedTextOf = (version: Pick<TemplateSceneVersion, 'metrics'> | null): string[] =>
  paintedLinesOf(version).map((line) => line.text);

export const frac = (value: number): string => value.toFixed(2);
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const boxText = (box: Rect): string =>
  `x0=${frac(box.x)} y0=${frac(box.y)} x1=${frac(box.x + box.w)} y1=${frac(box.y + box.h)}`;

export interface Marking {
  kind: 'retângulo' | 'pincel' | 'laço';
  box: Rect;
}

/** A marcação gravada na versão: forma (pincel e laço) ou retângulo (retângulo e zona). */
export function markingOf(
  version: Pick<TemplateSceneVersion, 'requestedRegion' | 'requestedMask'>,
  sceneAspect: number,
): Marking | null {
  const mask: MaskShape | null = version.requestedMask;
  if (mask) {
    return {
      kind: mask.kind === 'brush' ? 'pincel' : 'laço',
      box: version.requestedRegion ?? maskBounds(mask, sceneAspect),
    };
  }
  return version.requestedRegion ? { kind: 'retângulo', box: version.requestedRegion } : null;
}

/** Caixa da camada em frações da cena (o `x`, `y` é o centro e `w` a largura). */
export function layerBox(
  layer: SceneElement,
  scene: Pick<TemplateScene, 'widthPx' | 'heightPx'>,
): Rect {
  const h = (layer.w * scene.widthPx) / layer.aspect / scene.heightPx;
  return { x: layer.x - layer.w / 2, y: layer.y - h / 2, w: layer.w, h };
}

const OPERATION_LABEL: Record<string, string> = {
  generate: 'gerada',
  redraw: 'redesenhada',
  manual: 'ajuste manual',
  set_layer: 'camada alterada',
  restore: 'restaurada',
};

const FACE_NAME: Record<FaceKey, string> = {
  single: 'da cena',
  front: 'da Frente',
  back: 'do Verso',
  outer: 'da Externa',
  inner: 'da Interna',
};

/** Rótulo da face na conversa e na lista de pedidos; item sem `faceKey` é da primeira face. */
const FACE_LABEL: Partial<Record<FaceKey, string>> = {
  back: 'Verso',
  outer: 'Externa',
  inner: 'Interna',
};
export const faceLabelOf = (key?: FaceKey): string => (key && FACE_LABEL[key]) || 'Frente';

/** Resumo das versões: número exibido, operação e data, para "é a versão 7?" e "volta para a 3". */
export function versionsBlock(
  versions: DisplayedVersion[],
  currentId: string | null,
  faceKey: FaceKey = 'single',
): string {
  const title = `Versões ${FACE_NAME[faceKey]}`;
  if (versions.length === 0) return `${title}: nenhuma imagem ainda.`;
  const lines = versions.map(
    (v) =>
      `- Versão ${v.displayNumber}: ${OPERATION_LABEL[v.operation] ?? v.operation} em ${v.createdAt.toISOString().slice(0, 16).replace('T', ' ')}${v.id === currentId ? ' (a atual)' : ''}`,
  );
  return `${title} (número exibido):\n${lines.join('\n')}`;
}

/**
 * Formato e zonas (D-51): nome, tamanho em cm e em px da master, e as faixas de `computeSceneZones` em cm, em
 * fração e em px. O Diretor escolhe a região pelo nome; as medidas que vão ao modelo de imagem são do código.
 */
export function formatBlock(
  scene: Pick<TemplateScene, 'formatId' | 'widthPx' | 'heightPx'>,
  zones?: SceneZones,
): string {
  const format = findSceneFormat(scene.formatId);
  const size = `${scene.widthPx} x ${scene.heightPx} px`;
  if (!format) return `Formato: ${scene.formatId}, ${size}.`;
  const faceZones = zones ?? computeSceneZones(format);
  if (faceZones.fold) return tabloidFormatBlock(scene, format, faceZones);
  const bands = zoneBands(faceZones, scene.heightPx);
  // A zona que a face não tem não é escrita: o Diretor não a escolhe (PV-9).
  const parts = [
    hasZone(faceZones, 'header') &&
      `header = ${format.headerCm} cm (${bands.headerPct}% da altura, y < ${bands.headerEnd} px)`,
    `body = miolo de produtos (y de ${bands.headerEnd} a ${bands.footerStart} px)`,
    hasZone(faceZones, 'footer') &&
      `footer = ${format.footerCm} cm de ${format.printHeightCm} cm (${bands.footerPct}% da altura, y ≥ ${bands.footerStart} px)`,
  ].filter(Boolean);
  return [
    `Formato: ${format.id}, ${format.artWidthCm} x ${format.artHeightCm} cm, master de ${size}.`,
    `Zonas de image.region: ${parts.join('; ')}.`,
  ].join('\n');
}

/**
 * Bloco de faces (só na cena de frente e verso, escrito pelo código): a face do pedido, se tem imagem, as zonas de
 * cada face e quando usar `fazer_verso` (PV-14).
 */
export function facesBlock(face: { key: FaceKey; hasImage: boolean }): string {
  const name = face.key === 'back' ? 'Verso' : 'Frente';
  return `Cena de frente e verso. Face deste pedido: ${name} (${face.hasImage ? 'com imagem' : 'vazia'}). A frente tem cabeçalho e não tem rodapé; o verso não tem cabeçalho e tem rodapé. Use turn_kind fazer_verso só quando o cliente pedir para fazer ou criar o verso.`;
}

export function paintedBlock(lines: PaintedLine[]): string {
  if (lines.length === 0) return 'Textos já pintados na imagem atual: nenhum.';
  const shown = lines.map(
    (line) => `“${oneLine(line.text)}”${line.unchecked ? ' (não conferido)' : ''}`,
  );
  return `Textos já pintados na imagem atual (cite sem inventar): ${shown.join(' / ')}`;
}

export function briefBlock(brief: BriefItem[], labelFaces = false): string {
  // Na cena de frente e verso cada item leva a face dele (PV-8); sem `faceKey`, a frente.
  const tag = (item: BriefItem): string => (labelFaces ? `[${faceLabelOf(item.faceKey)}] ` : '');
  const open = brief.filter((item) => item.status === 'open');
  // Item superado (D-59) já ficou para trás: não é contexto nem pendência.
  const closed = brief
    .filter((item) => item.status === 'done' || item.status === 'dropped')
    .slice(-10);
  const lines = [
    open.length
      ? `Pedidos do cliente em aberto, do turno anterior (execute só o que a mensagem atual pede):\n${open.map((i) => `- ${i.id}: ${tag(i)}${oneLine(i.text)}`).join('\n')}`
      : 'Pedidos do cliente em aberto, do turno anterior: nenhum.',
  ];
  if (closed.length) {
    lines.push(
      `Pedidos já resolvidos ou desistidos (só contexto):\n${closed
        .map(
          (i) =>
            `- ${i.id} (${i.status === 'done' ? 'feito' : 'desistido'}): ${tag(i)}${oneLine(i.text)}`,
        )
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}

export interface HistoryEntry {
  message: TemplateSceneMessage;
  displayNumber: number | null;
  marking: Marking | null;
  /** Rótulo da face ("Frente", "Verso") na cena de frente e verso; ausente na cena de uma face. */
  faceLabel?: string;
}

export function historyBlock(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'Histórico da conversa: nenhuma mensagem anterior.';
  const lines = entries.map(({ message, displayNumber, marking, faceLabel }) => {
    const who = message.role === 'user' ? 'Cliente' : 'Assistente';
    const notes: string[] = faceLabel ? [faceLabel] : [];
    if (displayNumber !== null) notes.push(`versão ${displayNumber}`);
    if (marking) notes.push(`com marcação (${marking.kind}, ${boxText(marking.box)})`);
    return `${who}${notes.length ? ` [${notes.join(', ')}]` : ''}: ${oneLine(message.content)}`;
  });
  return `Histórico da conversa:\n${lines.join('\n')}`;
}
