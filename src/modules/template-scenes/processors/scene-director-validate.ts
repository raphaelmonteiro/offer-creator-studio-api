import { parseDirector } from '../domain/scene-director';
import { checkComposition, CompositionGroup } from '../domain/scene-director-composition';
import {
  answersWithoutImage,
  callsImage,
  hasInstruction,
  unusableAnswer,
  wantsImage,
} from '../domain/scene-director-decision';
import { applyNumberRule, NumberPatch } from '../domain/scene-director-number';
import { DirectorPlan } from '../domain/scene-director-schema';
import {
  checkExactText,
  checkTextOutsideBlock,
  stripTextOutsideBlock,
  TextPatch,
  TextSources,
} from '../domain/scene-exact-text';
import { DirectorContext } from '../services/scene-director-context';

/** O que o código cortou do plano depois de refazer uma vez: número (D-42) e texto fora do bloco (D-51). */
export interface PlanPatches {
  number?: NumberPatch[];
  text?: TextPatch[];
}

export interface Problem {
  reason: string;
  groups?: CompositionGroup[];
  number?: boolean;
  instruction?: boolean;
  text?: boolean;
}

export const QUESTION_OUTCOMES = {
  number: 'number_question',
  instruction: 'instruction_question',
  exact_text: 'exact_text_question',
} as const;

export type Checked =
  | { plan: DirectorPlan; patches?: PlanPatches }
  | Problem
  | { question: keyof typeof QUESTION_OUTCOMES };

const INSTRUCTION_RETRY_REASON =
  'o plano chama a imagem sem dizer o que mudar: preencha image.change com a mudança desta rodada';

const ANSWER_RETRY_REASON =
  'o plano diz que não muda a imagem, mas a resposta está vazia ou anuncia uma ação ("vou"): responda ao cliente sem prometer nada, ou chame a imagem de verdade preenchendo image.change';

/** Texto pedido (4a) e texto fora do bloco (4b) de um plano que chama imagem. */
function checkText(
  plan: DirectorPlan,
  sources: TextSources,
  final: boolean,
): Checked & { patches?: PlanPatches } {
  const image = plan.image;
  if (!image) return { plan };
  const exact = checkExactText(image.exact_text, sources);
  if (exact.ok === false) {
    return final ? { question: 'exact_text' } : { reason: exact.reason, text: true };
  }
  const outside = checkTextOutsideBlock(image, sources);
  if (outside.ok === true) return { plan };
  if (!final) return { reason: outside.reason, text: true };
  const stripped = stripTextOutsideBlock(image, sources);
  return { plan: { ...plan, image: stripped.image }, patches: { text: stripped.patches } };
}

/**
 * Valida o texto do Diretor: schema, texto e pedidos (1 a 3), texto exato e texto fora do bloco (4a, 4b),
 * composição (5), número (7) e instrução (8). Plano que não chama imagem não passa por 4, 5 e 7: elas protegem o
 * prompt (R32). A logo é a única recusa (4c). Nenhuma regra recusa pedido de escrita (D-51).
 */
export function validate(text: string, context: DirectorContext, final: boolean): Checked {
  const parsed = parseDirector(text, {
    message: context.script.message,
    clientMessages: context.clientMessages,
    briefItems: context.briefItems,
    marked: context.script.marked,
  });
  if (parsed.ok === false) return { reason: parsed.reason };
  if (parsed.plan.turn_kind === 'recusa_pintado' || parsed.plan.refusal) {
    return { plan: parsed.plan };
  }
  const sources = { clientMessages: context.clientMessages, paintedText: context.paintedText };
  const calls = callsImage(parsed.plan);
  const texted = calls ? checkText(parsed.plan, sources, final) : { plan: parsed.plan };
  if (!('plan' in texted)) return texted;
  const plan = texted.plan;
  const composition = calls
    ? checkComposition(plan, context.clientMessages)
    : { ok: true as const };
  if (composition.ok === false) return { reason: composition.reason, groups: composition.groups };
  const written = calls
    ? applyNumberRule(plan, { final, paintedText: context.paintedText })
    : { kind: 'ok' as const, plan, patches: [] as NumberPatch[] };
  if (written.kind === 'retry') return { reason: written.reason, number: true };
  if (written.kind === 'question') return { question: 'number' };
  const emptyAnswer = answersWithoutImage(written.plan) && unusableAnswer(written.plan.reply);
  if ((wantsImage(written.plan) && !hasInstruction(written.plan)) || emptyAnswer) {
    return final
      ? { question: 'instruction' }
      : { reason: emptyAnswer ? ANSWER_RETRY_REASON : INSTRUCTION_RETRY_REASON, instruction: true };
  }
  const patches: PlanPatches = {
    ...(written.patches.length ? { number: written.patches } : {}),
    ...(texted.patches?.text?.length ? { text: texted.patches.text } : {}),
  };
  return Object.keys(patches).length ? { plan: written.plan, patches } : { plan: written.plan };
}
