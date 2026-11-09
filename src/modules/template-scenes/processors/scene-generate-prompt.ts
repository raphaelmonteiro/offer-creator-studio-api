import { DirectorPlan } from '../domain/scene-director-schema';
import { findSceneFormat } from '../domain/scene-formats';
import { buildReferencePrompt } from '../domain/scene-reference-prompts';
import { ReferenceConcept } from '../domain/scene-reference.types';
import { buildOuterPrompt } from '../domain/scene-tabloid-prompts';
import { buildGeneratePrompt, correctionLines, planRequest, TextCorrection } from './scene-prompt';
import { TurnContext } from './scene-turn-state';

/**
 * O prompt da primeira imagem e da imagem nova (`generate`): o da Externa do jornal (PV-T6, com as zonas da versão
 * em curso) ou o de sempre (D-38) nas outras cenas. Com a ficha do encarte (`concept`), o da referência (uma face) ou a
 * Externa do jornal com o conceito (D-2).
 */
export function generatePromptFor(
  ctx: TurnContext,
  input: {
    plan: DirectorPlan;
    openItems?: string[];
    corrections?: TextCorrection[];
    /** Ficha limpa do encarte de referência: só a geração nascida da ficha passa isto (change add-template-scene-from-reference). */
    concept?: ReferenceConcept;
  },
): string {
  const { plan, openItems, corrections = [], concept } = input;
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
      concept,
    });
  }
  if (concept) {
    return buildReferencePrompt({
      artWidthCm: ctx.artWidthCm,
      artHeightCm: ctx.artHeightCm,
      widthPx: ctx.widthPx,
      heightPx: ctx.heightPx,
      zones: ctx.zones,
      concept,
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
