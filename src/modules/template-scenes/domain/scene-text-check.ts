/**
 * Conferência do texto pintado (D-51, G3b): o juiz transcreve o que está escrito na imagem e o CÓDIGO compara com a
 * linha pedida. Igualdade estrita depois de juntar espaços repetidos e trocar aspas tipográficas por retas: acento,
 * cedilha, caixa, vírgula, ponto e `R$` contam. Diferença ou leitura vazia é erro.
 */

export interface ReadLine {
  pedido: string;
  lido: string;
}

export interface TextLine {
  /** A linha pedida (ou já pintada), como deve estar na imagem. */
  asked: string;
  /** O que o juiz leu; vazio se não achou o texto. */
  read: string;
  ok: boolean;
  /** Linha já pintada em versão anterior que sumiu da imagem (o cliente pode ter tirado a placa): não é erro, PV-83. */
  gone?: boolean;
}

/** Espaços repetidos viram um, e aspas tipográficas viram retas; o resto fica como está. */
export function normalizeReadText(text: string): string {
  return text
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A leitura do juiz de uma linha esperada: pelo `pedido` que ele devolveu, ou pela posição se a ordem bate. */
function readingOf(expected: string[], reading: ReadLine[], index: number): string {
  const asked = normalizeReadText(expected[index]);
  const byAsked = reading.find((entry) => normalizeReadText(entry.pedido) === asked);
  if (byAsked) return byAsked.lido;
  return reading.length === expected.length ? (reading[index]?.lido ?? '') : '';
}

/** Compara cada linha esperada com o que o juiz leu. Sem linhas esperadas, não há nada a comparar. */
export function compareReadText(expected: string[], reading: ReadLine[]): TextLine[] {
  return expected.map((asked, index) => {
    const read = readingOf(expected, reading, index);
    const ok = read.trim() !== '' && normalizeReadText(read) === normalizeReadText(asked);
    return { asked, read, ok };
  });
}

/** Alguma linha saiu diferente do pedido? */
export const hasTextError = (lines: TextLine[]): boolean => lines.some((line) => !line.ok);

/** As linhas erradas, no formato da linha de correção da refação (`pedido`, `lido`). */
export const wrongLines = (lines: TextLine[]): Array<{ asked: string; read: string }> =>
  lines.filter((line) => !line.ok).map(({ asked, read }) => ({ asked, read }));
