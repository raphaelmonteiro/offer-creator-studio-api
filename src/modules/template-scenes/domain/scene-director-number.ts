import { DirectorPlan } from './scene-director-schema';
import { hasWrittenNumber, onlyNumberLeft, stripNumberClauses } from './scene-written-number';

/**
 * Validação 7 (D-42): nenhum prompt de imagem pede ano, data ou número escrito. O detector olha
 * `what_to_put`, `what_to_change`, `inventory_keep` e `requests.text`, e o efeito vem em ordem:
 * 1. `inventory_keep` e `requests`: o item sai, sem refazer o plano.
 * 2. `what_to_put` em que só sobra o número ("2027 em cima"): `recusa_pintado`, com a oferta da camada exata.
 * 3. Nos demais casos, o Diretor é refeito uma vez, com o motivo (`problem`).
 * 4. Persistindo (`final`), o código corta só o trecho com o número e grava o que cortou. Campo que fica vazio
 *    vira pergunta, sem imagem. É o oposto da composição de propósito: aqui o resto do pedido continua valendo.
 */

/** Turnos em que os campos do plano não vão ao gerador. */
const NOT_PAINTED_TURNS: ReadonlySet<DirectorPlan['turn_kind']> = new Set([
  'camada',
  'desfazer',
  'recusa_pintado',
]);

export interface NumberPatch {
  field: 'what_to_put' | 'what_to_change';
  before: string;
  after: string;
}

export type NumberRuleResult =
  | { kind: 'ok'; plan: DirectorPlan; patches: NumberPatch[] }
  /** O Diretor tem de ser refeito, com este motivo. */
  | { kind: 'retry'; reason: string }
  /** O campo ficou vazio depois do corte: pergunta ao cliente, sem imagem. */
  | { kind: 'question' };

export const NUMBER_RETRY_REASON =
  'o plano leva ano, data ou número escrito ao modelo de imagem; o ano citado pelo cliente é só contexto: não o escreva em what_to_put, what_to_change nem inventory_keep, nem como pedido';

/** Passo 1: item de `inventory_keep` e de `requests` com número sai do plano, sem refazer. */
function withoutNumberItems(plan: DirectorPlan): DirectorPlan {
  const keep = plan.inventory_keep.filter((item) => !hasWrittenNumber(item));
  const requests = plan.requests.filter(
    (request) => request.action !== 'open' || !hasWrittenNumber(request.text, { removal: true }),
  );
  return keep.length === plan.inventory_keep.length && requests.length === plan.requests.length
    ? plan
    : { ...plan, inventory_keep: keep, requests };
}

export function applyNumberRule(plan: DirectorPlan, options: { final: boolean }): NumberRuleResult {
  const cleaned = withoutNumberItems(plan);
  if (NOT_PAINTED_TURNS.has(cleaned.turn_kind)) return { kind: 'ok', plan: cleaned, patches: [] };
  const putHas = hasWrittenNumber(cleaned.what_to_put);
  const changeHas = hasWrittenNumber(cleaned.what_to_change, { removal: true });
  if (!putHas && !changeHas) return { kind: 'ok', plan: cleaned, patches: [] };
  if (putHas && onlyNumberLeft(cleaned.what_to_put)) {
    return {
      kind: 'ok',
      plan: {
        ...cleaned,
        turn_kind: 'recusa_pintado',
        refusal: 'painted_text',
        will_change_image: false,
      },
      patches: [],
    };
  }
  if (!options.final) return { kind: 'retry', reason: NUMBER_RETRY_REASON };
  const patches: NumberPatch[] = [];
  const patched = { ...cleaned };
  if (putHas) {
    patched.what_to_put = stripNumberClauses(cleaned.what_to_put);
    patches.push({ field: 'what_to_put', before: cleaned.what_to_put, after: patched.what_to_put });
  }
  if (changeHas) {
    patched.what_to_change = stripNumberClauses(cleaned.what_to_change, { removal: true });
    patches.push({
      field: 'what_to_change',
      before: cleaned.what_to_change,
      after: patched.what_to_change,
    });
  }
  return patches.some((patch) => !patch.after.trim())
    ? { kind: 'question' }
    : { kind: 'ok', plan: patched, patches };
}
