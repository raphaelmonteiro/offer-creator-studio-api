import {
  DirectorImage,
  DirectorLayerOp,
  DirectorPlan,
  PaintedRefusal,
} from './scene-director-schema';
import { emptyImage, imageChange } from './scene-director-image';
import { NO_IMAGE_REPLY, NO_INSTRUCTION_REPLY } from '../scene-texts';
import { FIXED_ANSWER, replyIsForbidden, safeReply } from './scene-director-phrases';
import { fold } from '../../../shared/text/fold';

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
  | { kind: 'reply'; reply: string }
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
      planPatch?: { will_change_image: true; image: DirectorImage };
      /** Aviso do redesenho só vale em edição: a primeira imagem e a imagem nova não contam (D-35). */
      isEdit: boolean;
    };

/** Tipos que podem pedir imagem: quem decide é `will_change_image`, e o `reply` é a resposta quando ele é falso. */
const IMAGE_KINDS = new Set<DirectorPlan['turn_kind']>([
  'pedido_item',
  'pedido_ajuste_geral',
  'pedido_composicao',
  'imagem_nova',
  'reclamacao',
]);

/**
 * O plano diz o que fazer na imagem? Sem `image.change` o prompt sairia vazio (G2). O "marquei" monta a instrução
 * dos pedidos em aberto (`markedPatch`) e por isso não conta aqui.
 */
export function hasInstruction(plan: Pick<DirectorPlan, 'image' | 'turn_kind'>): boolean {
  if (plan.turn_kind === 'marcacao_sem_pedido') return true;
  return Boolean(imageChange(plan));
}

/** O plano pede imagem? `will_change_image` é respeitado (validação 8); "marquei" tem regra própria. */
export function wantsImage(plan: Pick<DirectorPlan, 'turn_kind' | 'will_change_image'>): boolean {
  return IMAGE_KINDS.has(plan.turn_kind) && plan.will_change_image;
}

/** Tipo que pede imagem mas o Diretor disse que não muda: o `reply` é a resposta ao cliente. */
export function answersWithoutImage(
  plan: Pick<DirectorPlan, 'turn_kind' | 'will_change_image'>,
): boolean {
  return IMAGE_KINDS.has(plan.turn_kind) && !plan.will_change_image;
}

/** Raízes dos verbos de edição no futuro ("remov" + "erei"); fora da lista a resposta passa (R45, D-48). */
const FUTURE_ROOTS =
  '(?:remov|troc|tir|retir|apag|elimin|substitu|coloc|adicion|ajust|alter|mud|aplic|acrescent|inser|cri|ger|desenh|pint|mov|aument|diminu|clare|escurec|inclu|transform|recri|refaz|ret[o]rn|recompon|complet|corrig|reduz|ampli)';

/** Anunciar ("vou", "irei") sem mudar a imagem quebraria G8: "não vou conseguir" não é anúncio. */
const ANNOUNCES = new RegExp(
  [
    '\\b(?:vou|irei|vamos)\\b',
    // futuro simples em lista ("removerei", "farei"): "encontrei" e "procurei" são passado (R33, R45)
    `\\b(?:${FUTURE_ROOTS}[aei]rei|farei|porei)\\b`,
    '\\b(?:sera|serao)\\s+\\w+[ai]d[oa]s?\\b',
    '\\b(?:estou|estamos)\\s+(?!vendo|olhando|observando|notando|enxergando|identificando|percebendo)\\w+ndo\\b',
  ]
    .map((part) => `(?<!\\bnao\\s)(?<!\\bnem\\s)${part}`)
    .join('|'),
);

/** A resposta de um plano que não muda a imagem não serve: vazia ou anunciando uma ação. Refaz uma vez. */
export function unusableAnswer(reply: string): boolean {
  const text = reply.trim();
  return !text || ANNOUNCES.test(fold(text));
}

/** O plano chama o modelo de imagem (pedido direto, reclamação com ação, ou "marquei")? */
export function callsImage(plan: Pick<DirectorPlan, 'turn_kind' | 'will_change_image'>): boolean {
  return wantsImage(plan) || plan.turn_kind === 'marcacao_sem_pedido';
}

/** O plano muda a imagem? Pedido que a quer, ou "marquei" com pedido em aberto. */
function changesImage(input: DecisionInput): boolean {
  const { plan, marked, openRequests } = input;
  if (wantsImage(plan)) return true;
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

/** Cabe no campo `image.change` do schema (500 caracteres) e no anúncio (260). */
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
  if (plan.will_change_image && imageChange(plan)) return null;
  const image = emptyImage({
    ...plan.image,
    change: joinRequests(openRequests, 400),
    region: { zone: 'marked', side: null },
  });
  return {
    announcement: `Vou fazer na área marcada o que você pediu antes: ${joinRequests(openRequests, 190)}.`,
    planPatch: { will_change_image: true, image },
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
    return { kind: 'refuse', refusal: 'painted_logo' };
  }
  if ((plan.turn_kind === 'camada' || plan.turn_kind === 'desfazer') && !hasImage) {
    return { kind: 'reply', reply: NO_IMAGE_REPLY };
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
  if (changesImage(input)) {
    return hasInstruction(plan)
      ? imageDecision(input)
      : { kind: 'reply', reply: NO_INSTRUCTION_REPLY };
  }
  if (answersWithoutImage(plan)) {
    // O Diretor respondeu em vez de pedir imagem (por exemplo, não viu o objeto): a resposta vai como leitura (G8). Sem
    // resposta que sirva, ou barrada, o texto fixo, sem o prefixo.
    const text = plan.reply.trim();
    return unusableAnswer(text) || replyIsForbidden(text)
      ? { kind: 'reply', reply: NO_INSTRUCTION_REPLY }
      : { kind: 'reply', reply: text };
  }
  // D-51: a resposta vai como o Diretor escreveu, sem prefixo; barrada ou vazia, cai no texto fixo.
  return { kind: 'reply', reply: safeReply({ ...plan, will_change_image: false }) };
}
