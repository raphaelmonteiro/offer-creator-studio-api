import { DirectorPlan } from '../domain/scene-director-schema';
import { findSceneFormat } from '../domain/scene-formats';
import { buildOuterPrompt } from '../domain/scene-tabloid-prompts';
import { buildGeneratePrompt, correctionLines, planRequest, TextCorrection } from './scene-prompt';
import { TurnContext } from './scene-turn-state';

/**
 * O prompt da primeira imagem e da imagem nova (`generate`): o da Externa do jornal (PV-T6, com as zonas da versão
 * em curso) ou o de sempre (D-38) nas outras cenas.
 */
export function generatePromptFor(
  ctx: TurnContext,
  input: { plan: DirectorPlan; openItems?: string[]; corrections?: TextCorrection[] },
): string {
  const { plan, openItems, corrections = [] } = input;
  const format = findSceneFormat(ctx.formatId);
  if (ctx.layout === 'tabloid' && ctx.faceKey === 'outer' && format) {
    return buildOuterPrompt({
      format,
      widthPx: ctx.widthPx,
      heightPx: ctx.heightPx,
      zones: ctx.zones,
      request: planRequest(plan),
      openItems,
      exactText: plan.image?.exact_text,
      correctionLines: correctionLines(corrections),
    });
  }
  return buildGeneratePrompt({
    request: planRequest(plan),
    artWidthCm: ctx.artWidthCm,
    artHeightCm: ctx.artHeightCm,
    widthPx: ctx.widthPx,
    heightPx: ctx.heightPx,
    openItems,
    formatId: ctx.formatId,
    clientMessages: ctx.clientMessages,
    exactText: plan.image?.exact_text,
    corrections,
  });
}
