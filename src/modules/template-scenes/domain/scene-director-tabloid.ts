import { SceneFormatSpec } from './scene-formats';
import {
  HEADER_MIN_CM,
  headerCmOf,
  headerMaxCm,
  isTabloidFace,
  tabloidMeasures,
  TabloidFaceKey,
} from './scene-tabloid';
import { SceneZones } from './scene.types';

/**
 * O que o Diretor lê do jornal de 4 páginas (change add-template-scene-tabloid): o bloco de faces e as zonas da face em
 * meia largura, em pt-BR, escritos pelo código com as medidas em px. Só entram no contexto da cena `tabloid`.
 */

const cmText = (cm: number): string => String(cm).replace('.', ',');

const FACE_LABEL: Record<TabloidFaceKey, string> = { outer: 'Externa', inner: 'Interna' };

/** Zonas da face para `image.region` (substitui o `formatBlock` de largura inteira no jornal). */
export function tabloidFormatBlock(
  scene: { formatId: string; widthPx: number; heightPx: number },
  format: SceneFormatSpec,
  zones: SceneZones,
): string {
  const m = tabloidMeasures(zones, { widthPx: scene.widthPx, heightPx: scene.heightPx });
  const head = `Formato: ${format.id}, ${format.artWidthCm} x ${format.artHeightCm} cm, master de ${m.width} x ${m.height} px.`;
  const fold = `Faixa da dobra (x de ${m.foldFrom} a ${m.foldTo} px): nada nela, em nenhuma face.`;
  if (zones.header.h === 0) {
    return [
      head,
      `Zonas de image.region: body = a arte contínua das páginas 2 e 3, sem cabeçalho e sem rodapé (a Interna não tem header nem footer).`,
      fold,
    ].join('\n');
  }
  const cm = headerCmOf(zones, format);
  return [
    head,
    `Zonas de image.region: header = cabeçalho da capa, só na metade direita (x ≥ ${m.headerX} px, ${cmText(cm)} cm, y < ${m.headerEnd} px); body = miolo de produtos (a metade esquerda acima da faixa do rodapé e a metade direita abaixo do cabeçalho); footer = faixa do rodapé da loja, só na contracapa (metade esquerda, x < ${m.footerEndX} px, y ≥ ${m.footerStart} px).`,
    fold,
  ].join('\n');
}

/** Bloco de faces do jornal (só na cena `tabloid`): a face do pedido, as duas faces, o lado e as regras da capa. */
export function tabloidFacesBlock(
  face: { key: string; hasImage: boolean; zones: SceneZones },
  format: SceneFormatSpec,
): string {
  const key: TabloidFaceKey = isTabloidFace(face.key) ? face.key : 'outer';
  const lines = [
    `Jornal de 4 páginas, folha deitada dobrada no meio. Face deste pedido: ${FACE_LABEL[key]} (${face.hasImage ? 'com imagem' : 'vazia'}). Externa: metade esquerda = página 4 (contracapa, com a faixa do rodapé da loja embaixo), metade direita = página 1 (capa, com o cabeçalho no alto). Interna: páginas 2 e 3, uma arte contínua sem cabeçalho, sem rodapé e sem texto. Nada na faixa da dobra. Lado left = contracapa ou página 2; right = capa ou página 3.`,
    'A capa não tem rodapé; a faixa do rodapé fica na contracapa.',
    'Use turn_kind fazer_verso só quando o cliente pedir para fazer ou criar a parte de dentro (interna, páginas 2 e 3).',
  ];
  if (key === 'outer') {
    lines.push(
      `Altura atual do cabeçalho da capa: ${cmText(headerCmOf(face.zones, format))} cm (de ${HEADER_MIN_CM} a ${headerMaxCm(format)} cm).`,
    );
  }
  return lines.join(' ');
}
