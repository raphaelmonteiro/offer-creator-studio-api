import { hexToRgb, McCutoutKeyColor, MC_CUTOUT_KEY_RULE_VERSION } from './mc-cutout-key';

/**
 * Recorte do clipe falado por cor-chave no ffmpeg (change video-mascote-transparente, D5).
 * Funções puras que montam o trecho do filtergraph; o `compose_ffmpeg` e a verificação de
 * qualidade (D7) usam a MESMA cadeia, então o que é medido é o que é composto.
 */

/** Versão do recorte: entra no hash do `compose_ffmpeg` (só no modo sem fundo). */
export const MC_CUTOUT_GRAPH_VERSION = 1;
/** Tolerâncias do chromakey: constantes no código (API e worker precisam concordar com o hash). */
export const MC_CUTOUT_SIMILARITY = 0.12;
export const MC_CUTOUT_BLEND = 0.05;
/** Versão do matte (despill + erosão + suavização). */
export const MC_CUTOUT_MATTE_VERSION = 1;

/** Entrada do grafo de composição no modo sem fundo. */
export interface ComposeCutoutInput {
  keyColor: McCutoutKeyColor;
  framing: 'busto' | 'corpo';
}

/** O que entra no hash do `compose_ffmpeg` no modo sem fundo (D10). */
export function composeCutoutHashInput(cutout: ComposeCutoutInput): {
  keyColor: string;
  framing: string;
  similarity: number;
  blend: number;
  matteVersion: number;
  keyRuleVersion: number;
  graphVersion: number;
} {
  return {
    keyColor: cutout.keyColor,
    framing: cutout.framing,
    similarity: MC_CUTOUT_SIMILARITY,
    blend: MC_CUTOUT_BLEND,
    matteVersion: MC_CUTOUT_MATTE_VERSION,
    keyRuleVersion: MC_CUTOUT_KEY_RULE_VERSION,
    graphVersion: MC_CUTOUT_GRAPH_VERSION,
  };
}

/** `0xRRGGBB` para o chromakey. */
export function cutoutKeyHex(keyColor: McCutoutKeyColor): string {
  const [r, g, b] = hexToRgb(keyColor);
  return `0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

/** `despill` só trata verde e azul: o tipo vem da chave (a verde #00B140 e a azul #0047BB). */
export function cutoutDespillType(keyColor: McCutoutKeyColor): 'green' | 'blue' {
  const [, g, b] = hexToRgb(keyColor);
  return g >= b ? 'green' : 'blue';
}

/**
 * Do clipe `[src]` ao clipe com alfa `[out]`: sobe o croma a 4:4:4 (o 4:2:0 sangra a cor-chave na
 * borda), remove a chave, remove o reflexo dela (despill) e limpa/suaviza o matte (erosão de 1
 * passo + blur leve). `tag` torna os rótulos internos únicos por clipe.
 */
export function buildCutoutKeyChain(
  src: string,
  keyColor: McCutoutKeyColor,
  tag: string,
  out: string,
): string {
  return (
    `[${src}]format=yuv444p,` +
    `chromakey=color=${cutoutKeyHex(keyColor)}:similarity=${MC_CUTOUT_SIMILARITY}:blend=${MC_CUTOUT_BLEND},` +
    `despill=type=${cutoutDespillType(keyColor)}:mix=0.5:expand=0.1,` +
    `split=2[k${tag}][m${tag}];` +
    `[m${tag}]alphaextract,erosion,gblur=sigma=0.7[mm${tag}];` +
    `[k${tag}][mm${tag}]alphamerge[${out}]`
  );
}

/** Encaixe INTEIRO na janela, centralizado e colado embaixo, com a sobra transparente. */
export function cutoutFitFilters(windowWidth: number, windowHeight: number): string[] {
  return [
    `scale=${windowWidth}:${windowHeight}:force_original_aspect_ratio=decrease`,
    `pad=${windowWidth}:${windowHeight}:(ow-iw)/2:oh-ih:color=black@0`,
  ];
}
