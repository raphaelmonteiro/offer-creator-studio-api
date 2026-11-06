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
];

/** Verbos de conclusão: o anúncio é intenção, e quem conclui é o juiz. */
const COMPLETION =
  /\b(?:pronto|pronta|prontos|prontas|feito|feita|concluido|concluida|conclui|terminei|finalizei|removi|troquei|alterei|mudei|ajustei|coloquei|adicionei|tirei|apaguei|apliquei|substitui|atualizei|corrigi|resolvi|resolvido)\b/;

/** Promessa de texto pintado: letras, frases e palavras na imagem são camadas. */
const PAINTED_PROMISE =
  /\b(?:escrev\w*|escrit[oa]s?|com letras|com o texto|com a frase|com a palavra)\b/;

/** O texto traz promessa de preservação ("fora da área nada mudou", "preservado", "idêntico")? */
export function promisesPreservation(text: string): boolean {
  const folded = fold(text);
  return PRESERVATION.some((phrase) => folded.includes(phrase));
}

/** O `reply` do Diretor é barrado: preservação, conclusão e, só em anúncio de imagem, promessa de texto pintado. */
export function replyIsForbidden(reply: string, announcesChange = true): boolean {
  const folded = fold(reply);
  // A promessa de texto pintado só importa no anúncio de uma imagem: "está escrito Feliz Páscoa" é resposta (C-1).
  const paintedPromise = announcesChange && PAINTED_PROMISE.test(folded);
  return promisesPreservation(reply) || COMPLETION.test(folded) || paintedPromise;
}

/** `reply` seguro para o cliente: o do Diretor, ou o texto fixo (anúncio ou resposta) se ele for barrado. */
export function safeReply(plan: Pick<DirectorPlan, 'reply' | 'will_change_image'>): string {
  const reply = plan.reply.trim();
  if (reply && !replyIsForbidden(reply, plan.will_change_image)) return reply;
  return plan.will_change_image ? FIXED_ANNOUNCEMENT : FIXED_ANSWER;
}

/** O `mudou` do juiz: o dele, ou o texto fixo se trouxer promessa de preservação ou vier vazio. */
export function safeChanged(changed: string): string {
  const text = changed.trim();
  return text && !promisesPreservation(text) ? text : FIXED_CHANGED;
}

/** A descrição de emenda do juiz passa pelo mesmo filtro de `mudou`; barrada ou vazia, sai sem descrição. */
export function safeSeamDescription(description: string): string {
  const text = description.trim();
  return text && !promisesPreservation(text) ? text : '';
}
