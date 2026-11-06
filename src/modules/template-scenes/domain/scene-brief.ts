import { fold } from '../../../shared/text/fold';
import { DirectorRequest } from './scene-director-schema';

/**
 * Memória do que o cliente pediu (G9): `template_scenes.brief`. O que foi pedido e ainda não apareceu na
 * imagem continua em aberto entre os turnos e as sessões. **Abre:** os `requests` do Diretor, já validados
 * contra as mensagens do cliente. **Fecha:** só o juiz, quando vê o item na imagem nova. **Desiste:** só com
 * citação literal do cliente (validada antes, em `parseDirector`). **Reabre:** o juiz não vê mais um item
 * feito depois de um redesenho. Funções puras: quem grava é o consumer, na transação do turno.
 */

export type BriefStatus = 'open' | 'done' | 'dropped';

export interface BriefItem {
  /** Id curto e estável na cena (`p1`, `p2`...): é o que o Diretor e o juiz citam. */
  id: string;
  text: string;
  status: BriefStatus;
  sourceMessageId: string;
  updatedAt: string;
}

/** O que mudou na lista no turno (vai para `metrics.director.brief`). */
export interface BriefChanges {
  opened: string[];
  dropped: string[];
  closed: string[];
  reopened: string[];
}

export interface BriefResult {
  brief: BriefItem[];
  changes: BriefChanges;
}

const noChanges = (): BriefChanges => ({ opened: [], dropped: [], closed: [], reopened: [] });

const key = (text: string): string => fold(text).replace(/\s+/g, ' ').trim();

/** Itens que o Diretor e o juiz recebem como "ainda em aberto". */
export const openItems = (brief: BriefItem[]): BriefItem[] =>
  brief.filter((item) => item.status === 'open');

function nextId(brief: BriefItem[]): string {
  const numbers = brief.map((item) => Number(/^p(\d+)$/.exec(item.id)?.[1] ?? 0));
  return `p${Math.max(0, ...numbers) + 1}`;
}

/** O pedido do Diretor aponta para qual item? Pelo id, ou (sem id) pelo mesmo texto ou texto contido. */
function findItem(brief: BriefItem[], request: DirectorRequest): BriefItem | undefined {
  if (request.id) return brief.find((item) => item.id === request.id);
  const wanted = key(request.text);
  return (
    brief.find((item) => key(item.text) === wanted) ??
    brief.find((item) => key(item.text).includes(wanted) || wanted.includes(key(item.text)))
  );
}

export interface DirectorBriefContext {
  messageId: string;
  now: Date;
}

/**
 * Aplica os `requests` do Diretor. `open` sem item igual cria um item novo; `open` de item feito ou
 * desistido o reabre (o cliente pediu de novo); `drop` desiste do item (a citação já foi conferida).
 * Pedido repetido não duplica item.
 */
export function applyDirectorRequests(
  brief: BriefItem[],
  requests: DirectorRequest[],
  ctx: DirectorBriefContext,
): BriefResult {
  const changes = noChanges();
  const next = brief.map((item) => ({ ...item }));
  const updatedAt = ctx.now.toISOString();
  for (const request of requests) {
    const found = findItem(next, request);
    if (request.action === 'drop') {
      if (found && found.status !== 'dropped') {
        Object.assign(found, { status: 'dropped', updatedAt, sourceMessageId: ctx.messageId });
        changes.dropped.push(found.id);
      }
    } else if (!found) {
      const id = nextId(next);
      next.push({
        id,
        text: request.text,
        status: 'open',
        sourceMessageId: ctx.messageId,
        updatedAt,
      });
      changes.opened.push(id);
    } else if (found.status !== 'open') {
      Object.assign(found, { status: 'open', updatedAt, sourceMessageId: ctx.messageId });
      changes.reopened.push(found.id);
    }
  }
  return { brief: next, changes };
}

export interface JudgeBriefVerdict {
  /** Itens que o juiz viu na imagem nova. */
  seen: string[];
  /** Itens que o juiz não viu. */
  notSeen: string[];
}

/**
 * Aplica o veredito do juiz: item aberto visto fecha; item feito que o juiz não vê mais volta a abrir
 * (reabre sem refazer nada, e o chat relata). Só o juiz fecha. Id desconhecido é ignorado.
 */
export function applyJudgeVerdict(
  brief: BriefItem[],
  verdict: JudgeBriefVerdict,
  now: Date,
): BriefResult {
  const changes = noChanges();
  const updatedAt = now.toISOString();
  const next = brief.map((item) => {
    if (item.status === 'open' && verdict.seen.includes(item.id)) {
      changes.closed.push(item.id);
      return { ...item, status: 'done' as const, updatedAt };
    }
    if (item.status === 'done' && verdict.notSeen.includes(item.id)) {
      changes.reopened.push(item.id);
      return { ...item, status: 'open' as const, updatedAt };
    }
    return item;
  });
  return { brief: next, changes };
}

/** Itens em aberto que o juiz não viu: o chat diz "Ainda não vi na imagem: ...". */
export function stillMissing(brief: BriefItem[], verdict: JudgeBriefVerdict): BriefItem[] {
  return openItems(brief).filter((item) => verdict.notSeen.includes(item.id));
}
