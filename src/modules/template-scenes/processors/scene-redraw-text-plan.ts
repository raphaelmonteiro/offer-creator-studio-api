import { DirectorPlan } from '../domain/scene-director-schema';
import { ExpectedLine, expectedLines, roundZone } from '../domain/scene-painted-text';
import { Rect } from '../domain/scene.types';
import { TextPlan } from './scene-redraw-judge';
import { textCropBox } from './scene-text-crop';
import { TurnContext } from './scene-turn-state';

/** O texto a conferir desta rodada, com a zona de cada linha, para gravar `metrics.paintedText` da versão nova. */
export interface RoundText extends TextPlan {
  lines: ExpectedLine[];
  /** As linhas herdadas que a rodada não substitui: o bloco 8 manda mantê-las (4d, R65). */
  keep: string[];
}

/**
 * Texto a conferir (D-56, R65): as linhas da rodada mais as mantidas, nas rodadas com e sem texto novo. Na imagem nova
 * (`generate`) o texto antigo não vale: a imagem é outra.
 */
export function buildRoundText(
  ctx: TurnContext,
  plan: DirectorPlan,
  marking: Rect | null,
): RoundText {
  const image = plan.image;
  const inherited = ctx.operation === 'redraw' ? (ctx.parent?.paintedText ?? []) : [];
  const zone = roundZone({
    regionZone: image?.region.zone ?? 'whole',
    marking,
    zones: ctx.zones,
  });
  const lines = expectedLines({ lines: image?.exact_text ?? [], zone }, inherited);
  const expected = lines.map((line) => line.text);
  return {
    lines,
    expected,
    keep: lines.filter((line) => line.inherited).map((line) => line.text),
    known: inherited.map((line) => line.text).filter((text) => !expected.includes(text)),
    inherited: lines.map((line) => line.inherited),
    crop: textCropBox({
      region: image?.region ?? null,
      marking,
      zones: ctx.zones,
      width: ctx.widthPx,
      height: ctx.heightPx,
    }),
  };
}
