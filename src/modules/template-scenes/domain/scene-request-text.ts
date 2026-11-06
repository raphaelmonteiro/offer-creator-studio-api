import { fold } from '../../../shared/text/fold';
import { Side } from './scene-layer.types';
import { SceneZoneName } from './scene.types';

/**
 * Leitura do texto do pedido por palavra-chave, só para os sinais estruturados que ficam sem modelo
 * (D-19): o elemento selecionado (mover, redimensionar, tirar, integrar) e a posição da logo anexada.
 * O resto da intenção vem do modelo (`scene-intent.ts`). Tudo roda sobre o texto "dobrado" (minúsculo,
 * sem acento, mesmo comprimento do original). Verbos valem por palavra inteira: "remover" nunca casa
 * com "mover", e "integral" nunca casa com "integrar".
 */

const MOVE_WORDS = /\b(mov(er|e|a|am|endo)|desloc\w+|movimenta\w*)\b/;
const MOVE_SIDE =
  /\b(troc\w*|invert\w*|mud\w*)\b.*\b(de lado|outro lado|lado)\b|\b(de lado|outro lado)\b/;
const MOVE_TO_DIRECTION =
  /\b(lev(a|ar|e)|pass(a|ar|e)|coloc(a|ar|e)|po(e|nha)|joga\w*)\b.*\bpara\b.*\b(esquerda|direita|centro|cima|baixo|frente|lado)\b/;
const RESIZE_UP = /\b(maior|aument\w+|cresc\w+|grande)\b/;
const RESIZE_DOWN = /\b(menor|diminu\w+|reduz\w*|pequen\w+)\b/;
const REMOVE_WORDS = /\b(remov\w+|tir(a|ar|e)|apag\w+|delet\w+|exclu\w+)\b/;
/** As formas do verbo (R28): "integral" fica de fora. */
const INTEGRATE_WORDS =
  /\b(integr(a|e|ar|am|em|ando|ado|ada)|incorpor(a|e|ar|am|em|ando|ado|ada)|fund(a|ir|e)|mescl(a|e|ar|am|em|ando|ado|ada))\b/;

export function mentionsMove(folded: string): boolean {
  return MOVE_WORDS.test(folded) || MOVE_SIDE.test(folded) || MOVE_TO_DIRECTION.test(folded);
}

export const mentionsResize = (folded: string): 'bigger' | 'smaller' | null =>
  RESIZE_UP.test(folded) ? 'bigger' : RESIZE_DOWN.test(folded) ? 'smaller' : null;

export const mentionsRemove = (folded: string): boolean => REMOVE_WORDS.test(folded);

/** "Integrar" uma camada ao fundo, nas formas do verbo. */
export const mentionsIntegrate = (folded: string): boolean => INTEGRATE_WORDS.test(folded);

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

/** Zona nomeada do encarte (posição da logo anexada), em qualquer posição do texto. */
export function detectZone(text: string): SceneZoneName | null {
  const f = fold(text);
  for (const zone of ['header', 'body', 'footer'] as const) {
    if (new RegExp(`\\b(${ZONE_WORDS[zone]})\\b`).test(f)) return zone;
  }
  return null;
}
