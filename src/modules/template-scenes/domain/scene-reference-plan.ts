import { BriefItem, supersedeAtTurnEnd } from './scene-brief';
import { DirectorPlan } from './scene-director-schema';
import { conceptEnglish } from './scene-reference-summary';
import { ReferenceConcept, ReferenceSummary } from './scene-reference.types';

/** O plano do turno de geração por referência, montado pelo código: sem Diretor, sem texto, sem camadas. */
export function referencePlan(concept: ReferenceConcept): DirectorPlan {
  return {
    turn_kind: 'imagem_nova',
    will_change_image: true,
    reply: '',
    image: {
      composition: '',
      style: '',
      change: conceptEnglish(concept).slice(0, 500),
      region: { zone: 'whole', side: null },
      preserve: [],
      exact_text: [],
    },
    what_i_see: '',
    undo_target: null,
    layer_ops: [],
    requests: [],
    refusal: null,
  };
}

const ITEM_MAX = 80;

/**
 * Os itens do turno que o juiz confere (um por elemento usado). Antes, o que sobrou aberto de turnos anteriores fica
 * superado, como no fim de qualquer turno (D-59).
 */
export function openReferenceItems(
  brief: BriefItem[],
  input: { summary: ReferenceSummary; messageId: string; now: Date },
): BriefItem[] {
  const { summary, messageId, now } = input;
  const base = supersedeAtTurnEnd(brief, { messageId, now }).brief;
  const numbers = base.map((item) => Number(/^p(\d+)$/.exec(item.id)?.[1] ?? 0));
  let next = Math.max(0, ...numbers);
  const opened = summary.uses.map(
    (use): BriefItem => ({
      id: `p${++next}`,
      text: use.slice(0, ITEM_MAX),
      status: 'open',
      sourceMessageId: messageId,
      updatedAt: now.toISOString(),
    }),
  );
  return [...base, ...opened];
}

/** O item "feito" que o contexto do Diretor carrega depois da imagem pronta (o conceito do encarte). */
export function conceptDoneItem(
  brief: BriefItem[],
  input: { text: string; messageId: string; now: Date },
): BriefItem[] {
  const numbers = brief.map((item) => Number(/^p(\d+)$/.exec(item.id)?.[1] ?? 0));
  return [
    ...brief,
    {
      id: `p${Math.max(0, ...numbers) + 1}`,
      text: input.text,
      status: 'done',
      sourceMessageId: input.messageId,
      updatedAt: input.now.toISOString(),
    },
  ];
}
