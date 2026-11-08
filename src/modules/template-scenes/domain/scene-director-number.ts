import { DirectorPlan } from './scene-director-schema';
import { hasWrittenNumber, stripNumberClauses } from './scene-written-number';

/**
 * Validação 7 (D-42, ajustada por D-51): nenhum bloco de contexto do prompt pede ano, data ou número escrito. O
 * detector olha `image.composition`, `style`, `change`, `preserve` e `requests.text`; **`image.exact_text` não
 * passa por aqui**: o número que o cliente pediu para escrever ("coloca 2027 em cima") é texto exato e vai pintado.
 * O efeito, em ordem:
 * 1. `preserve` e `requests`: o item sai, sem refazer o plano (`preserve` fica se o número é texto já pintado).
 * 2. Nos demais campos, o Diretor é refeito uma vez, com o motivo.
 * 3. Persistindo (`final`), o código corta só o trecho com o número e grava o que cortou. `change` que fica vazio
 *    vira pergunta, sem imagem. É o oposto da composição de propósito: aqui o resto do pedido continua valendo.
 */

/** Turnos em que os campos do plano não vão ao gerador. */
const NOT_PAINTED_TURNS: ReadonlySet<DirectorPlan['turn_kind']> = new Set([
  'camada',
  'desfazer',
  'recusa_pintado',
]);

type NumberField = 'composition' | 'style' | 'change';
const FIELDS: readonly NumberField[] = ['composition', 'style', 'change'];

export interface NumberPatch {
  field: NumberField;
  before: string;
  after: string;
}

export type NumberRuleResult =
  | { kind: 'ok'; plan: DirectorPlan; patches: NumberPatch[] }
  /** O Diretor tem de ser refeito, com este motivo. */
  | { kind: 'retry'; reason: string }
  /** `image.change` ficou vazio depois do corte: pergunta ao cliente, sem imagem. */
  | { kind: 'question' };

export const NUMBER_RETRY_REASON =
  'o plano leva ano, data ou número escrito aos blocos de contexto da imagem; o ano citado pelo cliente é só contexto: não o escreva em composition, style, change nem preserve, nem como pedido; o número que o cliente quer ver escrito vai só em exact_text';

const removalOf = (field: NumberField): { removal: boolean } => ({ removal: field === 'change' });

/** Passo 1: item de `preserve` e de `requests` com número sai do plano, sem refazer. */
function withoutNumberItems(plan: DirectorPlan, painted: string[]): DirectorPlan {
  if (!plan.image) return plan;
  const known = painted.join(' \n ');
  const preserve = plan.image.preserve.filter(
    (item) => !hasWrittenNumber(item) || known.includes(item),
  );
  const requests = plan.requests.filter(
    (request) => request.action !== 'open' || !hasWrittenNumber(request.text, { removal: true }),
  );
  return preserve.length === plan.image.preserve.length && requests.length === plan.requests.length
    ? plan
    : { ...plan, image: { ...plan.image, preserve }, requests };
}

export function applyNumberRule(
  plan: DirectorPlan,
  options: { final: boolean; paintedText?: string[] },
): NumberRuleResult {
  const cleaned = withoutNumberItems(plan, options.paintedText ?? []);
  const image = cleaned.image;
  if (NOT_PAINTED_TURNS.has(cleaned.turn_kind) || !image) {
    return { kind: 'ok', plan: cleaned, patches: [] };
  }
  const dirty = FIELDS.filter((field) => hasWrittenNumber(image[field], removalOf(field)));
  if (dirty.length === 0) return { kind: 'ok', plan: cleaned, patches: [] };
  if (!options.final) return { kind: 'retry', reason: NUMBER_RETRY_REASON };
  const patched = { ...image };
  const patches: NumberPatch[] = dirty.map((field) => {
    patched[field] = stripNumberClauses(image[field], removalOf(field));
    return { field, before: image[field], after: patched[field] };
  });
  return patches.some((patch) => patch.field === 'change' && !patch.after.trim())
    ? { kind: 'question' }
    : { kind: 'ok', plan: { ...cleaned, image: patched }, patches };
}
