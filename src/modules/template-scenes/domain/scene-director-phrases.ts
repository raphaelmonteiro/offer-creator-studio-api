import { fold } from '../../../shared/text/fold';
import { DirectorPlan } from './scene-director-schema';

/**
 * Validação 6 (G8): o chat só afirma o que foi conferido. Frases que prometem preservação ou afirmam
 * conclusão são barradas no `reply` do Diretor e no texto do juiz, e trocadas por texto fixo do código.
 */

/** Anúncio fixo, no futuro, quando o `reply` de um plano que muda a imagem é barrado. */
export const FIXED_ANNOUNCEMENT = 'Vou fazer a mudança que você pediu.';
/** Resposta fixa quando o `reply` barrado era uma resposta (a imagem não muda). */
export const FIXED_ANSWER =
  'Não consegui formular uma resposta confiável agora. Pode reformular a pergunta?';
/** Texto fixo quando o `mudou` do juiz é barrado. */
export const FIXED_CHANGED = 'O pedido aparece atendido.';

/** Promessa de preservação: nunca vai ao cliente, venha de onde vier. */
const PRESERVATION = [
  'fora da area',
  'nada mudou',
  'nada mais mudou',
  'preserv',
  'identic',
  'exatamente como',
  'intacto',
  'inalterad',
  'mais nada',
];

/**
 * Afirmação sobre o resto da imagem (R7): "resto", "restante" ou "demais" junto de "igual", "mant*", "sem mexer",
 * "sem alterar" ou "sem mudar", nas duas ordens. Citar um item ("mantendo o coelho") não é promessa.
 */
const REST_WORD = '(?:resto|restante|demais)';
const REST_CLAIM =
  '(?:igual|iguais|mant\\w*|sem mexer|sem alterar|sem mudar|continua|permanece|segue|nao muda|nao foi alterad\\w*|como esta|como estava|como antes)';
const REST_PROMISE = new RegExp(
  `\\b${REST_WORD}\\b.{0,40}\\b${REST_CLAIM}|\\b${REST_CLAIM}\\b.{0,40}\\b${REST_WORD}\\b`,
);

/** Verbos de conclusão: o anúncio é intenção, e quem conclui é o juiz. */
const COMPLETION =
  /\b(?:pronto|pronta|prontos|prontas|feito|feita|concluido|concluida|conclui|terminei|finalizei|removi|troquei|alterei|mudei|ajustei|coloquei|adicionei|tirei|apaguei|apliquei|substitui|atualizei|corrigi|resolvi|resolvido)\b/;

/** O texto traz promessa de preservação ("fora da área nada mudou", "preservado", "idêntico")? */
export function promisesPreservation(text: string): boolean {
  const folded = fold(text);
  return PRESERVATION.some((phrase) => folded.includes(phrase)) || REST_PROMISE.test(folded);
}

/**
 * O `reply` do Diretor é barrado: preservação e conclusão. Anunciar texto pintado é permitido (D-51): "Vou colocar uma
 * placa com a frase “Promoção de Páscoa”" é anúncio certo.
 */
export function replyIsForbidden(reply: string): boolean {
  return promisesPreservation(reply) || COMPLETION.test(fold(reply));
}

/** `reply` seguro para o cliente: o do Diretor, ou o texto fixo (anúncio ou resposta) se ele for barrado. */
export function safeReply(plan: Pick<DirectorPlan, 'reply' | 'will_change_image'>): string {
  const reply = plan.reply.trim();
  if (reply && !replyIsForbidden(reply)) return reply;
  return plan.will_change_image ? FIXED_ANNOUNCEMENT : FIXED_ANSWER;
}

/**
 * O `mudou` do juiz que pode ir ao cliente, ou vazio se vier vazio ou com promessa de preservação. O texto fixo
 * depende do veredito (`afterImageReply`): "O pedido aparece atendido" só cabe em `sim` (R6).
 */
export function safeChanged(changed: string): string {
  const text = changed.trim();
  return text && !promisesPreservation(text) ? text : '';
}

/** A descrição de emenda do juiz passa pelo mesmo filtro de `mudou`; barrada ou vazia, sai sem descrição. */
export function safeSeamDescription(description: string): string {
  const text = description.trim();
  return text && !promisesPreservation(text) ? text : '';
}
