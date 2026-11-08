import { ImageZone } from './scene-director-schema';
import { Rect, SceneZones } from './scene.types';
import { TextLine } from './scene-text-check';

/**
 * O texto pintado de cada versão (`metrics.paintedText`, D-56, rodada 6, R65 e R66): cada linha guarda o texto, a zona
 * em que foi pintada e, quando o juiz não pôde conferi-la, a marca `unchecked` (PV-94). A versão seguinte herda as
 * linhas, e o bloco 8 do prompt manda manter as que a rodada não substitui.
 */

export type PaintedZone = 'header' | 'body' | 'footer' | 'whole';

const ZONES: readonly string[] = ['header', 'body', 'footer', 'whole'];

export interface PaintedLine {
  text: string;
  /** Linha antiga, gravada só com o texto, não tem zona e é sempre mantida. */
  zone?: PaintedZone;
  /** A linha foi ao modelo, mas a leitura do juiz falhou ou o juiz ficou indisponível: segue valendo, sem conferência. */
  unchecked?: boolean;
}

/** Uma linha esperada na imagem desta rodada: a da rodada, ou a herdada que ela mantém. */
export interface ExpectedLine extends PaintedLine {
  inherited: boolean;
}

const same = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** As linhas de `metrics.paintedText`: aceita a forma antiga (só texto) e ignora o que não é linha. */
export function readPaintedLines(value: unknown): PaintedLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PaintedLine[] => {
    if (typeof entry === 'string') return entry.trim() ? [{ text: entry }] : [];
    const line = entry as Partial<PaintedLine> | null;
    if (typeof line?.text !== 'string' || !line.text.trim()) return [];
    const zone = ZONES.includes(line.zone as string) ? (line.zone as PaintedZone) : undefined;
    return [
      {
        text: line.text,
        ...(zone ? { zone } : {}),
        ...(line.unchecked === true ? { unchecked: true } : {}),
      },
    ];
  });
}

/** O campo da versão de origem, copiado para a versão que não muda a imagem (camada, camada à mão) ou a restaura. */
export function paintedMetricsOf(source: { metrics?: Record<string, unknown> | null }): {
  paintedText?: PaintedLine[];
} {
  const lines = readPaintedLines(source.metrics?.paintedText);
  return lines.length ? { paintedText: lines } : {};
}

/**
 * A zona da rodada: `image.region.zone`; com marcação, a zona de `computeSceneZones` que contém o centro da caixa;
 * `whole` (ou `marked` sem caixa) cobre todas as zonas.
 */
export function roundZone(input: {
  regionZone: ImageZone;
  marking: Rect | null;
  zones: SceneZones;
}): PaintedZone {
  const { marking, zones } = input;
  if (marking) {
    const center = marking.y + marking.h / 2;
    if (center < zones.header.y + zones.header.h) return 'header';
    return center >= zones.footer.y ? 'footer' : 'body';
  }
  const zone = input.regionZone;
  return zone === 'header' || zone === 'body' || zone === 'footer' ? zone : 'whole';
}

/**
 * As linhas esperadas na imagem: as da rodada, com a zona da rodada, e as mantidas. Linha herdada é substituída
 * quando a rodada tem texto novo, não a repete e foi pintada na mesma zona (ou a rodada é `whole`); a que não tem
 * zona gravada, ou é de outra, é mantida (4d, "Texto a manter").
 */
export function expectedLines(
  round: { lines: string[]; zone: PaintedZone },
  inherited: PaintedLine[],
): ExpectedLine[] {
  const fresh: ExpectedLine[] = round.lines.map((text) => ({
    text,
    zone: round.zone,
    inherited: false,
  }));
  const kept = inherited
    .filter((line) => !round.lines.some((text) => same(text, line.text)))
    .filter((line) => !replaces(round, line))
    .map((line) => ({ ...line, inherited: true }));
  return [...fresh, ...kept];
}

const replaces = (round: { lines: string[]; zone: PaintedZone }, line: PaintedLine): boolean =>
  round.lines.length > 0 &&
  line.zone !== undefined &&
  (round.zone === 'whole' || line.zone === round.zone);

/**
 * O `metrics.paintedText` da versão nova: as linhas que o juiz leu iguais na imagem aplicada, com a zona. Linha
 * herdada lida vazia sai (PV-83). Sem leitura (`null`: juiz indisponível, limite ou saída inválida), a linha da
 * rodada fica marcada como não conferida, e a herdada segue como estava (PV-94).
 */
export function nextPaintedLines(lines: ExpectedLine[], reading: TextLine[] | null): PaintedLine[] {
  return lines.flatMap((line, index): PaintedLine[] => {
    const zone = line.zone ? { zone: line.zone } : {};
    if (reading === null) {
      const unchecked = !line.inherited || line.unchecked ? { unchecked: true as const } : {};
      return [{ text: line.text, ...zone, ...unchecked }];
    }
    const read = reading[index];
    return read?.ok && !read.gone ? [{ text: line.text, ...zone }] : [];
  });
}
