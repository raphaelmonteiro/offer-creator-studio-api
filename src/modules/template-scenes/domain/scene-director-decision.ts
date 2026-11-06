import { DirectorLayerOp, DirectorPlan, PaintedRefusal } from './scene-director-schema';
import { NO_IMAGE_REPLY } from '../scene-texts';
import { safeReply } from './scene-director-phrases';

/**
 * O efeito de um turno vem de uma tabela do código sobre `turn_kind` e `will_change_image`, nunca de texto
 * livre do modelo. Esta função é pura: quem grava e quem chama a imagem é o consumer.
 */

export interface DecisionInput {
  plan: DirectorPlan;
  /** A mensagem trouxe marcação (retângulo, pincel, laço ou zona); `targetElementId` não conta. */
  marked: boolean;
  /** A cena já tem uma versão `ready` com imagem. */
  hasImage: boolean;
  /** Os itens da lista do que o cliente pediu em aberto, contando os que o plano abre agora (só o texto). */
  openRequests: string[];
}

type ImageDecision = Extract<TurnDecision, { kind: 'image' }>;

export type TurnDecision =
  | { kind: 'refuse'; refusal: PaintedRefusal }
  | { kind: 'reply'; reply: string; aboutImage: boolean }
  | { kind: 'layers'; ops: DirectorLayerOp[]; reply: string }
  | { kind: 'undo'; target: 'previous' | number }
  | {
      kind: 'image';
      /** `generate` não recebe imagem de referência (primeira imagem e imagem nova). */
      operation: 'generate' | 'redraw';
      /** Janela de 5 s com "Parar" antes da reserva da chamada de imagem. */
      window: boolean;
      /** Imagem nova com marcação: a marcação é descartada, e o anúncio avisa. */
      discardMarking: boolean;
      announcement: string;
      /**
       * "Marquei" com pedido em aberto, mas o plano do Diretor veio sem instrução (só uma pergunta): o código monta a
       * instrução a partir dos pedidos em aberto, e o plano gravado recebe estes campos por cima.
       */
      planPatch?: { will_change_image: true; what_to_change: string };
      /** Aviso do redesenho só vale em edição: a primeira imagem e a imagem nova não contam (D-35). */
      isEdit: boolean;
    };

const CHANGES_IMAGE = new Set<DirectorPlan['turn_kind']>([
  'pedido_item',
  'pedido_ajuste_geral',
  'pedido_composicao',
  'imagem_nova',
]);

/** O plano muda a imagem? Pedido direto sempre; reclamação e "marquei" por regra própria. */
function changesImage(input: DecisionInput): boolean {
  const { plan, marked, openRequests } = input;
  if (CHANGES_IMAGE.has(plan.turn_kind)) return true;
  if (plan.turn_kind === 'reclamacao') return plan.will_change_image;
  // "Marquei" executa o pedido em aberto na marcação; sem pedido em aberto, é pergunta.
  if (plan.turn_kind === 'marcacao_sem_pedido') return marked && openRequests.length > 0;
  return false;
}

/**
 * Janela de 5 s (D-29, opção a): só vale para plano que chama imagem. Pedido direto sem marcação, reclamação
 * (com ou sem marcação) e imagem nova têm janela; pedido direto com marcação e "marquei" executando pedido em
 * aberto não têm. Camadas, perguntas, recusas e desfazer nunca chegam aqui.
 */
export function windowApplies(kind: DirectorPlan['turn_kind'], marked: boolean): boolean {
  if (kind === 'imagem_nova' || kind === 'reclamacao') return true;
  if (kind === 'marcacao_sem_pedido') return false;
  return !marked;
}

/** Cabe no campo `what_to_change` do schema (400 caracteres) e no anúncio (260). */
const joinRequests = (texts: string[], max: number): string =>
  texts
    .map((text) =>
      text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!]+$/, ''),
    )
    .join('; ')
    .slice(0, max);

/** "Marquei" executa o que ficou em aberto; se o plano não traz a instrução, o código a monta dos pedidos. */
function markedPatch(
  input: DecisionInput,
): Pick<ImageDecision, 'announcement' | 'planPatch'> | null {
  const { plan, openRequests } = input;
  if (plan.turn_kind !== 'marcacao_sem_pedido') return null;
  if (plan.will_change_image && plan.what_to_change?.trim()) return null;
  return {
    announcement: `Vou fazer na área marcada o que você pediu antes: ${joinRequests(openRequests, 190)}.`,
    planPatch: { will_change_image: true, what_to_change: joinRequests(openRequests, 400) },
  };
}

function imageDecision(input: DecisionInput): TurnDecision {
  const { plan, marked, hasImage } = input;
  const isNewImage = !hasImage || plan.turn_kind === 'imagem_nova';
  const patch = markedPatch(input);
  return {
    kind: 'image',
    operation: isNewImage ? 'generate' : 'redraw',
    // A primeira imagem tem janela: é pedido sem marcação, e marcação não existe sem imagem.
    window: !hasImage || windowApplies(plan.turn_kind, marked),
    discardMarking: isNewImage && hasImage && marked,
    announcement: safeReply({ reply: plan.reply, will_change_image: true }),
    isEdit: hasImage && !isNewImage,
    ...patch,
  };
}

export function decideTurn(input: DecisionInput): TurnDecision {
  const { plan, hasImage } = input;
  if (plan.turn_kind === 'recusa_pintado') {
    return { kind: 'refuse', refusal: plan.refusal ?? 'painted_text' };
  }
  if ((plan.turn_kind === 'camada' || plan.turn_kind === 'desfazer') && !hasImage) {
    return { kind: 'reply', reply: NO_IMAGE_REPLY, aboutImage: false };
  }
  if (plan.turn_kind === 'camada' && plan.layer_ops.length > 0) {
    return {
      kind: 'layers',
      ops: plan.layer_ops,
      reply: safeReply({ ...plan, will_change_image: false }),
    };
  }
  if (plan.turn_kind === 'desfazer') {
    return { kind: 'undo', target: plan.undo_target ?? 'previous' };
  }
  if (changesImage(input)) return imageDecision(input);
  return {
    kind: 'reply',
    reply: safeReply({ ...plan, will_change_image: false }),
    aboutImage: plan.turn_kind === 'pergunta' && hasImage,
  };
}
