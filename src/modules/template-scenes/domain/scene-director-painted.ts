import { wantsImage } from './scene-director-decision';
import { DirectorPlan, PaintedRefusal } from './scene-director-schema';
import { classifyPainted, removedTerms } from './scene-painted-detector';
import { hasWrittenNumber } from './scene-written-number';

/**
 * Validação 4 (G3, D-45, D-46): texto, preço e logo não são pintados pelo modelo de imagem. O detector
 * (`scene-painted-detector.ts`) tem três saídas, e este arquivo as aplica ao plano:
 * - recusa (a), sem refazer: `what_to_put` e `what_to_change`, mais o `refusal` do Diretor (o campo `written_content`
 *   saiu do schema em D-47: listava até o texto que já existe);
 * - dúvida (b): refaz uma vez, sem dizer "não pinto"; persistindo, o chat pergunta, sem imagem;
 * - o resto segue. `inventory_keep` perde o item em a) ou b), sem refazer.
 * Só vale em plano que chama imagem: resposta e pergunta sobre texto escrito não são recusadas (R27).
 */

/** Turnos em que os campos do plano não são conteúdo pintado: camadas, desfazer e a própria recusa. */
const SKIPPED_TURNS: ReadonlySet<DirectorPlan['turn_kind']> = new Set([
  'camada',
  'desfazer',
  'recusa_pintado',
]);

/** O plano chama o modelo de imagem (pedido direto, reclamação com ação, ou "marquei")? */
const callsImage = (plan: DirectorPlan): boolean =>
  wantsImage(plan) || plan.turn_kind === 'marcacao_sem_pedido';

/** Recusa por forma inequívoca em `what_to_put` ou `what_to_change` (a). */
function refusalOf(plan: DirectorPlan): PaintedRefusal | null {
  const verdicts = [
    classifyPainted(plan.what_to_put, 'put'),
    classifyPainted(plan.what_to_change, 'change'),
  ];
  const refused = verdicts.filter((verdict) => verdict.level === 'refuse');
  return refused.find((v) => v.kind === 'painted_price')?.kind ?? refused[0]?.kind ?? null;
}

/**
 * Plano final: o que o Diretor recusou fica recusado (`refusal` preenche `turn_kind`), e o plano que chama imagem
 * com escrita inequívoca vira recusa. Nenhuma chamada de imagem sai de um plano recusado.
 */
export function enforcePaintedRefusal(plan: DirectorPlan): DirectorPlan {
  const kind =
    plan.refusal ??
    (SKIPPED_TURNS.has(plan.turn_kind) || !callsImage(plan) ? null : refusalOf(plan));
  if (!kind) {
    return plan.turn_kind === 'recusa_pintado'
      ? { ...plan, refusal: 'painted_text', will_change_image: false }
      : plan;
  }
  return { ...plan, turn_kind: 'recusa_pintado', refusal: kind, will_change_image: false };
}

export type PaintedCheck =
  | { kind: 'ok'; plan: DirectorPlan }
  | { kind: 'retry'; reason: string }
  /** A dúvida persistiu nas duas chamadas: o chat pergunta se o cliente quer isso escrito, sem imagem. */
  | { kind: 'question' };

/** O motivo da nova tentativa não diz "não pinto": o Diretor pode só ter citado o que já existe. */
export const PAINTED_RETRY_REASON =
  'o plano pode estar pedindo texto, preço ou logo escritos na imagem; se for só citar o que já existe, reescreva com palavras normais, sem aspas nem caixa alta; se for escrita, mantenha, que o sistema trata';

/**
 * Validação 4 inteira: recusa (a) na hora, dúvida (b) refaz uma vez e, persistindo (`final`), pergunta. Não corta
 * trecho: o cliente pode ter pedido a escrita, e a resposta certa é oferecer a camada.
 */
export function checkPainted(plan: DirectorPlan, options: { final: boolean }): PaintedCheck {
  const enforced = enforcePaintedRefusal(plan);
  if (enforced.turn_kind === 'recusa_pintado' || !callsImage(enforced)) {
    return { kind: 'ok', plan: enforced };
  }
  const keep = enforced.inventory_keep.filter(
    (item) => classifyPainted(item, 'change').level === 'none',
  );
  const cleaned =
    keep.length === enforced.inventory_keep.length
      ? enforced
      : { ...enforced, inventory_keep: keep };
  const removed = removedTerms(cleaned.what_to_change);
  const doubt =
    classifyPainted(cleaned.what_to_put, 'put', removed).level !== 'none' ||
    classifyPainted(cleaned.what_to_change, 'change').level !== 'none';
  if (!doubt) return { kind: 'ok', plan: cleaned };
  return options.final ? { kind: 'question' } : { kind: 'retry', reason: PAINTED_RETRY_REASON };
}

/**
 * Textos de pedidos em aberto que podem ir ao modelo de imagem (G3, D-42: também sem ano, data ou número). O item
 * que cairia em recusa ou dúvida continua na lista, mas não entra no prompt nem na instrução do "marquei":
 * "tirar o preço" não cai, e pode ir.
 */
export function promptableTexts(texts: string[]): string[] {
  return texts.filter(
    (text) =>
      classifyPainted(text, 'change').level === 'none' &&
      !hasWrittenNumber(text, { removal: true }),
  );
}
