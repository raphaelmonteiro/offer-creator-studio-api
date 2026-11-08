import { BriefItem, openItems } from './scene-brief';
import { DirectorPlan } from './scene-director-schema';
import { fold } from '../../../shared/text/fold';
import { mentionsWords } from './scene-words';

/**
 * Desistência genérica ("esquece isso", "deixa pra lá", "desisto", "não precisa", "não quero mais"), com ou sem
 * "isso": citação válida de `drop` mesmo sem palavra do item (validação 3). O alvo é resolvido pelo código.
 */
const GENERIC_DESIST =
  /\b(?:esquec\w*|deixa\s+(?:isso\s+)?(?:pra|para)\s+la|desist\w*|nao\s+precisa|nao\s+quero\s+mais)\b/;

export const isGenericDesist = (quote: string): boolean => GENERIC_DESIST.test(fold(quote));

export type DropResolution =
  | { kind: 'ok'; plan: DirectorPlan }
  /** Nenhum item em aberto: não há o que esquecer. */
  | { kind: 'none' }
  /** Alvo incerto: nada desiste, o chat pergunta qual esquecer, citando os itens em aberto. */
  | { kind: 'ask'; items: string[] };

/**
 * "Esquece isso" não nomeia o item: o alvo é claro quando há um só item em aberto, ou quando o `id` do Diretor é o
 * item aberto mais recente, a que "isso" se refere. Com o `id` em outro item, ou sem `id` havendo vários abertos,
 * nada desiste. Desistência com palavra do item (`esquece o rio`) não passa por aqui.
 */
export function resolveGenericDrops(plan: DirectorPlan, brief: BriefItem[]): DropResolution {
  const open = openItems(brief);
  let changed = false;
  const requests: DirectorPlan['requests'] = [];
  for (const request of plan.requests) {
    const target = request.id ? brief.find((item) => item.id === request.id) : undefined;
    const generic =
      request.action === 'drop' &&
      !mentionsWords(target?.text ?? request.text, request.quote ?? '') &&
      isGenericDesist(request.quote ?? '');
    if (!generic) {
      requests.push(request);
      continue;
    }
    if (open.length === 0) return { kind: 'none' };
    const latest = open[open.length - 1];
    const clear = open.length === 1 || request.id === latest.id ? latest : undefined;
    if (!clear) return { kind: 'ask', items: open.map((item) => item.text) };
    requests.push({ ...request, id: clear.id });
    changed = true;
  }
  return { kind: 'ok', plan: changed ? { ...plan, requests } : plan };
}
