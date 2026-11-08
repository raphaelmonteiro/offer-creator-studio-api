import { fold } from '../../../shared/text/fold';
import { DirectorRequest } from './scene-director-schema';
import { FaceKey } from './scene-faces';
import { numberKeepsOutOfList } from './scene-written-number';
import { mentionsWords, sameWholeWord, significantWords } from './scene-words';

/**
 * Memória do que o cliente pediu (G9): `template_scenes.brief`. O que foi pedido e ainda não apareceu na
 * imagem continua em aberto entre os turnos e as sessões. **Abre:** os `requests` do Diretor, já validados
 * contra as mensagens do cliente. **Fecha:** só o juiz, quando vê o item na imagem nova. **Desiste:** só com
 * citação literal do cliente (validada antes, em `parseDirector`). **Reabre:** só o cliente, pedindo de novo. A
 * conversa anda sempre para a frente (D-59): só o item do turno (da mensagem atual) é cobrado; ao fim de cada turno o
 * item aberto que não é dele fica `superseded`, e Parar fecha também o do turno parado. Funções puras: quem grava é o
 * consumer, na transação do turno.
 */

/** `superseded`: superado (o cliente seguiu em frente ou parou); não é desistência citada nem item feito. */
export type BriefStatus = 'open' | 'done' | 'dropped' | 'superseded';

export interface BriefItem {
  /** Id curto e estável na cena (`p1`, `p2`...): é o que o Diretor e o juiz citam. */
  id: string;
  text: string;
  status: BriefStatus;
  sourceMessageId: string;
  updatedAt: string;
  /** Face do pedido, só na cena de frente e verso (PV-8); ausente vale a face 0 (`front`). */
  faceKey?: FaceKey;
}

/** O que mudou na lista no turno (vai para `metrics.director.brief`). */
export interface BriefChanges {
  opened: string[];
  dropped: string[];
  closed: string[];
  reopened: string[];
  superseded: string[];
}

export interface BriefResult {
  brief: BriefItem[];
  changes: BriefChanges;
}

const noChanges = (): BriefChanges => ({
  opened: [],
  dropped: [],
  closed: [],
  reopened: [],
  superseded: [],
});

const key = (text: string): string => fold(text).replace(/\s+/g, ' ').trim();

/** A face do item: sem `faceKey`, a face 0 (`front` na cena de frente e verso). */
const faceOfItem = (item: BriefItem): FaceKey => item.faceKey ?? 'front';

/** Itens em aberto na lista; com `faceKey`, só os da face (PV-8). */
export const openItems = (brief: BriefItem[], faceKey?: FaceKey): BriefItem[] =>
  brief.filter((item) => item.status === 'open' && (!faceKey || faceOfItem(item) === faceKey));

/** Os itens do turno (D-59): abertos pela mensagem atual, ou do turno anterior que ela executa. */
export const turnItems = (brief: BriefItem[], messageId: string): BriefItem[] =>
  brief.filter((item) => item.status === 'open' && item.sourceMessageId === messageId);

function nextId(brief: BriefItem[]): string {
  const numbers = brief.map((item) => Number(/^p(\d+)$/.exec(item.id)?.[1] ?? 0));
  return `p${Math.max(0, ...numbers) + 1}`;
}

/** Todas as palavras de `small` aparecem em `big`, por palavra inteira. */
const coversWords = (small: string[], big: string[]): boolean =>
  small.length > 0 && small.every((word) => big.some((other) => sameWholeWord(word, other)));

/**
 * O pedido do Diretor aponta para qual item? Pelo id, ou (sem id) pelo mesmo texto ou por palavras inteiras
 * contidas num dos dois lados. Nunca por pedaço de palavra.
 */
function findItem(brief: BriefItem[], request: DirectorRequest): BriefItem | undefined {
  if (request.id) return brief.find((item) => item.id === request.id);
  const wanted = key(request.text);
  const wantedWords = significantWords(request.text);
  return (
    brief.find((item) => key(item.text) === wanted) ??
    brief.find((item) => {
      const words = significantWords(item.text);
      return coversWords(wantedWords, words) || coversWords(words, wantedWords);
    })
  );
}

export interface DirectorBriefContext {
  /** Face dos itens novos (só na cena de frente e verso); sem ela o item nasce sem `faceKey`. */
  faceKey?: FaceKey;
  messageId: string;
  /** A mensagem atual do cliente: só um pedido nela reabre um item feito ou desistido (R10). */
  message: string;
  now: Date;
}

/**
 * Item que o Diretor devolve em `requests`: o aberto do turno anterior passa a ser da mensagem atual (D-59); o feito,
 * desistido ou superado só reabre se o cliente pediu de novo na mensagem atual (R10, D-59).
 */
function adoptOrReopen(
  found: BriefItem,
  request: DirectorRequest,
  ctx: DirectorBriefContext & { updatedAt: string },
  changes: BriefChanges,
): void {
  if (found.status === 'open') {
    if (found.sourceMessageId !== ctx.messageId) {
      Object.assign(found, { updatedAt: ctx.updatedAt, sourceMessageId: ctx.messageId });
    }
    return;
  }
  if (!mentionsWords(request.text, ctx.message)) return;
  Object.assign(found, {
    status: 'open',
    updatedAt: ctx.updatedAt,
    sourceMessageId: ctx.messageId,
  });
  changes.reopened.push(found.id);
}

/**
 * Aplica os `requests` do Diretor. `open` sem item igual cria um item novo; `open` de item feito ou
 * desistido o reabre (o cliente pediu de novo); `drop` desiste do item (a citação já foi conferida).
 * Pedido repetido não duplica item. `open` com ano, data ou número escrito é ignorado (D-42).
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
    // Ano, data e número escrito não abrem pedido (D-42): o juiz relataria "Ainda não vi na imagem: 2027". Salvo o
    // número que o cliente pediu para pintar (D-54).
    if (request.action === 'open' && numberKeepsOutOfList(request.text, ctx.message)) continue;
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
        ...(ctx.faceKey ? { faceKey: ctx.faceKey } : {}),
      });
      changes.opened.push(id);
    } else {
      adoptOrReopen(found, request, { ...ctx, updatedAt }, changes);
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
 * Aplica o veredito do juiz: item aberto do turno visto fecha. Só ele fecha. O juiz não reabre item feito (D-59, muda
 * PV-60) e id que não é item do turno é ignorado.
 */
export function applyJudgeVerdict(
  brief: BriefItem[],
  verdict: JudgeBriefVerdict,
  ctx: { messageId: string; now: Date },
): BriefResult {
  const changes = noChanges();
  const updatedAt = ctx.now.toISOString();
  const inTurn = new Set(turnItems(brief, ctx.messageId).map((item) => item.id));
  const next = brief.map((item) => {
    if (inTurn.has(item.id) && verdict.seen.includes(item.id)) {
      changes.closed.push(item.id);
      return { ...item, status: 'done' as const, updatedAt };
    }
    return item;
  });
  return { brief: next, changes };
}

/**
 * Fim de todo turno (D-59): o item aberto que não é do turno fica superado, sem ser cobrado depois. Com `stopped`
 * (Parar), fecha também os do turno parado: a mensagem parada já era a mensagem seguinte ao turno anterior.
 */
export function supersedeAtTurnEnd(
  brief: BriefItem[],
  ctx: { messageId: string; now: Date; stopped?: boolean },
): BriefResult {
  const changes = noChanges();
  const updatedAt = ctx.now.toISOString();
  const next = brief.map((item) => {
    if (item.status !== 'open' || (!ctx.stopped && item.sourceMessageId === ctx.messageId)) {
      return item;
    }
    changes.superseded.push(item.id);
    return { ...item, status: 'superseded' as const, updatedAt };
  });
  return { brief: next, changes };
}

/**
 * A pergunta "qual destes você quer esquecer?" cita os itens em aberto: eles passam a ser da mensagem do turno, para
 * não ficarem superados antes de o cliente responder (PV-61). Se a resposta não os pedir, o turno seguinte os supera.
 */
export function adoptOpenItems(
  brief: BriefItem[],
  ctx: { messageId: string; now: Date },
): BriefItem[] {
  const updatedAt = ctx.now.toISOString();
  return brief.map((item) =>
    item.status === 'open' && item.sourceMessageId !== ctx.messageId
      ? { ...item, sourceMessageId: ctx.messageId, updatedAt }
      : item,
  );
}
