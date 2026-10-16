import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { isValidGtin } from '../gtin.util';
import { DotcompanyBudgetService } from './dotcompany-budget.service';
import {
  DOTCOMPANY_BATCH_MAX,
  DotcompanyAuthError,
  DotcompanyClient,
  DotcompanyIdempotencyError,
  DotcompanyNoCreditError,
  DotcompanyRateLimitedError,
  DotcompanyTransientError,
} from './dotcompany.client';
import type {
  BudgetDenyReason,
  ConsumerKind,
  DotcompanyLookupItem,
  DotcompanyProduct,
} from './dotcompany.types';
import {
  DotcompanyPendingBatchStore,
  IN_FLIGHT_RETRY_MS,
  PENDING_BATCH_MAX_ATTEMPTS,
  PendingBatchRow,
} from './dotcompany-pending-batch.store';
import { DotcompanyLookup } from './entities/dotcompany-lookup.entity';
import type { PendingBatchOutcome } from './entities/dotcompany-pending-batch.entity';

/** Preço por item encontrado quando a DotCompany não informa no header (4 créditos = R$ 0,04). */
export const CREDITS_PER_FOUND = 4;
/** Não encontrado só é consultado de novo depois disso (não encontrado não é cobrado). */
export const NOT_FOUND_RETRY_DAYS = 30;

export type EanClass =
  | { status: 'valid'; ean: string }
  | { status: 'invalid'; ean: string; reason: string }
  | { status: 'internal_use'; ean: string; reason: string };

/**
 * Normaliza e classifica um código. A chave canônica é a forma EAN-13 quando
 * o código é UPC-A (12) ou GTIN-14 com zero à esquerda; GTIN-8 fica como está.
 * Códigos de circulação restrita não têm cadastro nacional — nem consulta.
 */
export function classifyEan(raw: string | number | null | undefined): EanClass {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return { status: 'invalid', ean: '', reason: 'vazio' };
  if (![8, 12, 13, 14].includes(digits.length)) {
    return {
      status: 'invalid',
      ean: digits,
      reason: `comprimento ${digits.length} (esperado 8, 12, 13 ou 14)`,
    };
  }
  if (!isValidGtin(digits))
    return { status: 'invalid', ean: digits, reason: 'dígito verificador inválido' };

  let ean = digits;
  if (ean.length === 12) ean = `0${ean}`;
  if (ean.length === 14 && ean.startsWith('0')) ean = ean.slice(1);

  if (ean.length === 13 && ean.startsWith('2')) {
    return { status: 'internal_use', ean, reason: 'etiqueta de balança / uso interno (prefixo 2)' };
  }
  if (ean.length === 13 && (ean.startsWith('98') || ean.startsWith('99'))) {
    return { status: 'internal_use', ean, reason: 'cupom (prefixo 98/99)' };
  }
  if (ean.startsWith('7890000')) {
    return { status: 'internal_use', ean, reason: 'sequencial de software (7890000)' };
  }
  return { status: 'valid', ean };
}

export type LookupOutcomeStatus =
  | 'found'
  | 'not_found'
  | 'invalid'
  | 'internal_use'
  /** O controlador de consumo negou (ou a DotCompany respondeu 402/429). */
  | 'blocked'
  | 'error';

export interface LookupOutcome {
  /** EAN canônico (ou os dígitos, quando inválido). */
  ean: string;
  /** Como veio de quem pediu. */
  input: string;
  status: LookupOutcomeStatus;
  product?: DotcompanyProduct | null;
  lookup?: DotcompanyLookup | null;
  /** Veio do cache, sem chamada externa. */
  cached?: boolean;
  reason?: string | null;
  blockReason?: BudgetDenyReason | null;
  retryAt?: Date | null;
}

export interface LookupSummary {
  outcomes: Map<string, LookupOutcome>;
  /** Créditos gastos nesta resolução. */
  credits: number;
  /** Chamadas feitas à DotCompany. */
  requests: number;
  /** Primeiro bloqueio encontrado (as consultas seguintes param). */
  blocked: { reason: BudgetDenyReason; retryAt: Date | null; message: string | null } | null;
  /** Credencial recusada (401/403): não adianta tentar de novo sozinho. */
  authError: string | null;
}

/** Máximo de vezes que um chamador espera a consulta de outro antes de consultar por conta própria. */
const MAX_WAIT_ROUNDS = 3;

interface ResolveCtx {
  kind: ConsumerKind;
  now: Date;
  summary: LookupSummary;
  setFor: (ean: string, partial: Omit<LookupOutcome, 'ean' | 'input'>) => void;
}

/**
 * Chamada paga sem resposta do servidor (timeout nosso, rede cortada, abort): pode ter sido cobrada. Uma
 * resposta 5xx NÃO entra aqui: a DotCompany não cobra 4xx/5xx.
 */
function isUncertainFailure(err: unknown): boolean {
  if (err instanceof DotcompanyTransientError) return err.outcome !== 'http_5xx';
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function uncertainOutcome(err: unknown): 'timeout' | 'network' {
  if (err instanceof DotcompanyTransientError)
    return err.outcome === 'timeout' ? 'timeout' : 'network';
  return (err as { name?: string } | null)?.name === 'TimeoutError' ? 'timeout' : 'network';
}

/** Um lote a enviar; `pending` quando repete um lote de resultado incerto. */
interface Chunk {
  gtins: string[];
  pending: PendingBatchRow | null;
}

interface Attempt {
  chunk: Chunk;
  pending: PendingBatchRow;
  rest: string[];
  ctx: ResolveCtx;
  reserved: number;
  estimated: number;
  /** Já é a repetição com chave nova depois de descartar uma chave morta. */
  fresh: boolean;
}

function productOf(raw: DotcompanyLookupItem | null | undefined): DotcompanyProduct | null {
  return raw?.encontrado && raw.produto ? raw.produto : null;
}

/**
 * Fonte de dados de produto por EAN: cache local primeiro; o que falta vai à
 * DotCompany em lotes de até 100, sempre autorizado pelo controlador de
 * consumo. Cada EAN encontrado é pago no máximo uma vez.
 */
@Injectable()
export class DotcompanyLookupService {
  private readonly logger = new Logger(DotcompanyLookupService.name);
  /** EAN → consulta em andamento neste processo (1 processo PM2 em produção). */
  private readonly inflight = new Map<string, Promise<void>>();

  private readonly pending: DotcompanyPendingBatchStore;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly client: DotcompanyClient,
    private readonly budget: DotcompanyBudgetService,
  ) {
    this.pending = new DotcompanyPendingBatchStore(dataSource);
  }

  now(): Date {
    return this.budget.now();
  }

  async findCached(eans: string[]): Promise<Map<string, DotcompanyLookup>> {
    if (eans.length === 0) return new Map();
    const rows = await this.dataSource
      .getRepository(DotcompanyLookup)
      .find({ where: { ean: In(eans) } });
    return new Map(rows.map((r) => [r.ean, r]));
  }

  async setGalleryImage(ean: string, galleryImageId: string | null): Promise<void> {
    await this.dataSource.query(
      `UPDATE dotcompany_lookups SET "galleryImageId" = $2, "updatedAt" = now() WHERE ean = $1`,
      [ean, galleryImageId],
    );
  }

  /**
   * Resolve uma lista de EANs. A chave do mapa devolvido é o valor de entrada
   * (como veio), para o chamador casar com suas linhas.
   *
   * A chamada HTTP ao lote NUNCA é cancelada por prazo de quem chamou: a
   * DotCompany pode já ter processado e cobrado. Quem tem pressa deixa de
   * esperar (Promise.race) e a consulta termina em segundo plano, gravando
   * cache e consumo. EANs já em consulta por outro chamador (encarte, job)
   * esperam essa mesma consulta em vez de pagar de novo.
   */
  async resolve(inputs: string[], options: { kind: ConsumerKind }): Promise<LookupSummary> {
    const summary: LookupSummary = {
      outcomes: new Map(),
      credits: 0,
      requests: 0,
      blocked: null,
      authError: null,
    };
    const now = this.now();

    const byEan = new Map<string, string[]>();
    for (const input of inputs) {
      if (summary.outcomes.has(input)) continue;
      const c = classifyEan(input);
      if (c.status !== 'valid') {
        summary.outcomes.set(input, { ean: c.ean, input, status: c.status, reason: c.reason });
        continue;
      }
      const list = byEan.get(c.ean) ?? [];
      list.push(input);
      byEan.set(c.ean, list);
    }

    const ctx: ResolveCtx = {
      kind: options.kind,
      now,
      summary,
      setFor: (ean, partial) => {
        for (const input of byEan.get(ean) ?? [])
          summary.outcomes.set(input, { ean, input, ...partial });
      },
    };

    const missing = await this.applyCache([...byEan.keys()], ctx);
    await this.fetchMissing(missing, ctx, 0);
    return summary;
  }

  /** Preenche o que o cache resolve e devolve o que ainda precisa de consulta. */
  private async applyCache(eans: string[], ctx: ResolveCtx): Promise<string[]> {
    const cache = await this.findCached(eans);
    const missing: string[] = [];
    for (const ean of eans) {
      const row = cache.get(ean);
      if (row?.status === 'found') {
        ctx.setFor(ean, {
          status: 'found',
          product: productOf(row.raw),
          lookup: row,
          cached: true,
        });
      } else if (row?.status === 'not_found' && row.retryAfter && row.retryAfter > ctx.now) {
        ctx.setFor(ean, {
          status: 'not_found',
          lookup: row,
          cached: true,
          reason: 'não encontrado na DotCompany',
        });
      } else {
        missing.push(ean);
      }
    }
    return missing;
  }

  /**
   * Consulta o que falta: o que outro chamador já está consultando é esperado
   * (e relido do cache); o resto vai à DotCompany, registrado como "em voo".
   * Lote de resultado incerto de uma tentativa anterior é repetido idêntico
   * (mesmos GTINs, mesma `Idempotency-Key`) em vez de montar um lote novo.
   */
  private async fetchMissing(eans: string[], ctx: ResolveCtx, round: number): Promise<void> {
    if (eans.length === 0) return;
    const pendings = await this.pending.findFor(eans, this.now());
    // Síncrono daqui ao registro: ninguém passa entre a checagem e o registro.
    const { waitFor, chunks, deferred } = this.planChunks(eans, pendings, round);
    const dones = chunks.map((chunk) => this.registerInflight(chunk.gtins));
    this.deferBatches(deferred, ctx);

    const waiting = (async () => {
      if (waitFor.length === 0) return;
      await Promise.all(waitFor.map((w) => w.promise));
      const left = await this.applyCache(
        waitFor.map((w) => w.ean),
        ctx,
      );
      await this.fetchMissing(left, ctx, round + 1);
    })();

    try {
      await Promise.all([this.fetchOwn(chunks, dones, ctx), waiting]);
    } finally {
      for (const done of dones) done();
    }
  }

  private planChunks(
    eans: string[],
    pendings: PendingBatchRow[],
    round: number,
  ): {
    waitFor: Array<{ ean: string; promise: Promise<void> }>;
    chunks: Chunk[];
    deferred: Array<{ eans: string[]; retryAt: Date }>;
  } {
    const waitFor: Array<{ ean: string; promise: Promise<void> }> = [];
    const chunks: Chunk[] = [];
    const deferred: Array<{ eans: string[]; retryAt: Date }> = [];
    const now = this.now();
    const claimed = new Set<string>();
    const wanted = new Set(eans);
    for (const p of pendings) {
      const members = p.gtins.filter((g) => wanted.has(g) && !claimed.has(g));
      if (members.length === 0) continue;
      for (const m of members) claimed.add(m);
      const flying = p.gtins.map((g) => this.inflight.get(g)).find(Boolean);
      if (flying && round < MAX_WAIT_ROUNDS) {
        for (const ean of members) waitFor.push({ ean, promise: flying });
      } else if (flying) {
        // A chave está em voo neste processo: reenviá-la agora só devolveria 409 IN_FLIGHT. Fica para depois.
        deferred.push({ eans: members, retryAt: new Date(now.getTime() + IN_FLIGHT_RETRY_MS) });
      } else if (p.retryNotBefore && p.retryNotBefore > now) {
        // 409 IN_FLIGHT recente: o servidor ainda processa; respeita o intervalo mínimo com a MESMA chave.
        deferred.push({ eans: members, retryAt: p.retryNotBefore });
      } else {
        chunks.push({ gtins: p.gtins, pending: p });
      }
    }
    const mine: string[] = [];
    for (const ean of eans) {
      if (claimed.has(ean)) continue;
      const promise = this.inflight.get(ean);
      if (promise && round < MAX_WAIT_ROUNDS) waitFor.push({ ean, promise });
      else mine.push(ean);
    }
    for (let i = 0; i < mine.length; i += DOTCOMPANY_BATCH_MAX)
      chunks.push({ gtins: mine.slice(i, i + DOTCOMPANY_BATCH_MAX), pending: null });
    return { waitFor, chunks, deferred };
  }

  /** EANs de um lote ainda em processamento na DotCompany: bloqueados por pouco tempo (sem custo, sem erro). */
  private deferBatches(deferred: Array<{ eans: string[]; retryAt: Date }>, ctx: ResolveCtx): void {
    for (const d of deferred) {
      const message =
        'Lote ainda em processamento na DotCompany; repetido com a mesma chave depois.';
      ctx.summary.blocked ??= { reason: 'batch_in_flight', retryAt: d.retryAt, message };
      for (const ean of d.eans)
        ctx.setFor(ean, {
          status: 'blocked',
          blockReason: 'batch_in_flight',
          retryAt: d.retryAt,
          reason: message,
        });
    }
  }

  private registerInflight(eans: string[]): () => void {
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    for (const ean of eans) this.inflight.set(ean, promise);
    return () => {
      for (const ean of eans) if (this.inflight.get(ean) === promise) this.inflight.delete(ean);
      finish();
    };
  }

  private async fetchOwn(
    chunks: Chunk[],
    dones: Array<() => void>,
    ctx: ResolveCtx,
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      const rest = chunks.slice(i).flatMap((c) => c.gtins);
      const stop = await this.fetchChunk(chunks[i], rest, ctx);
      dones[i]();
      if (stop) {
        // Os lotes restantes não serão consultados por esta resolução: acorda quem espera por eles.
        for (let j = i + 1; j < dones.length; j++) dones[j]();
        return;
      }
    }
  }

  /** Uma chamada ao lote. Devolve `true` quando os próximos lotes não devem ser tentados. */
  private async fetchChunk(
    chunk: Chunk,
    rest: string[],
    ctx: ResolveCtx,
    fresh = false,
  ): Promise<boolean> {
    const { kind, summary, setFor } = ctx;
    const estimated = CREDITS_PER_FOUND * chunk.gtins.length;
    const auth = await this.budget.acquire({ kind, estimatedCredits: estimated });
    if (!auth.ok) {
      summary.blocked = { reason: auth.reason!, retryAt: auth.retryAt, message: auth.message };
      for (const ean of rest) {
        setFor(ean, {
          status: 'blocked',
          blockReason: auth.reason,
          retryAt: auth.retryAt,
          reason: auth.message,
        });
      }
      return true;
    }
    const reserved = auth.reserved ?? 0;

    let pending: PendingBatchRow | null;
    try {
      pending = await this.startAttempt(chunk);
    } catch (err) {
      await this.budget.release({ kind, requests: 0, errors: 1, reserved });
      const msg = (err as Error).message;
      this.logger.warn(`Lote DotCompany não iniciado (${chunk.gtins.length} EANs): ${msg}`);
      for (const ean of chunk.gtins) setFor(ean, { status: 'error', reason: msg });
      return false;
    }
    if (!pending) {
      // Outro chamador fechou este lote (apagou o pendente) depois da leitura: nada a enviar, o cache já tem a resposta.
      await this.budget.release({ kind, requests: 0, reserved });
      const left = await this.applyCache(chunk.gtins, ctx);
      for (const ean of left)
        setFor(ean, {
          status: 'error',
          reason: 'lote já fechado por outra consulta, sem resultado',
        });
      return false;
    }
    const attempt: Attempt = { chunk, pending, rest, ctx, reserved, estimated, fresh };

    summary.requests += 1;
    let res: Awaited<ReturnType<DotcompanyClient['lookupBatch']>>;
    try {
      res = await this.client.lookupBatch(pending.gtins, { idempotencyKey: pending.key });
    } catch (err) {
      return this.onBatchFailure(err, attempt);
    }
    await this.onBatchSuccess(res, attempt);
    return false;
  }

  /** Grava o lote ANTES de enviar (ou conta mais uma tentativa do pendente repetido). */
  private async startAttempt(chunk: Chunk): Promise<PendingBatchRow | null> {
    if (!chunk.pending) return this.pending.create(randomUUID(), chunk.gtins, this.now());
    // Devolve a linha ATUAL (custo já lançado, desfecho): ou `null` se outro chamador a fechou.
    return this.pending.startResend(chunk.pending.id);
  }

  /** O servidor respondeu: grava cache e consumo (só a diferença sobre o custo estimado já lançado). */
  private async onBatchSuccess(
    res: Awaited<ReturnType<DotcompanyClient['lookupBatch']>>,
    a: Attempt,
  ): Promise<void> {
    const { chunk, pending, ctx, reserved, estimated } = a;
    const { kind, summary, setFor, now } = ctx;
    const recorded = pending.creditsRecorded ?? 0;
    let released = false;
    try {
      const found = await this.storeBatch(chunk.gtins, res.items, now);
      const actual = res.creditsCharged ?? CREDITS_PER_FOUND * found.length;
      if (res.replay)
        this.logger.log(`Lote DotCompany repetido: replay (${pending.attempts}ª chamada).`);
      summary.credits += actual;
      released = true;
      await this.budget.release({
        kind,
        credits: Math.max(0, actual - recorded),
        found: found.length,
        notFound: chunk.gtins.length - found.length,
        rate: res.rate,
        reserved,
      });
      await this.quiet(this.pending.remove(pending.id));
      const rows = await this.findCached(chunk.gtins);
      for (const ean of chunk.gtins) {
        const row = rows.get(ean);
        if (row?.status === 'found')
          setFor(ean, { status: 'found', product: productOf(row.raw), lookup: row, cached: false });
        else
          setFor(ean, {
            status: 'not_found',
            lookup: row ?? null,
            cached: false,
            reason: 'não encontrado na DotCompany',
          });
      }
    } catch (err) {
      // A DotCompany respondeu (e pode ter cobrado), mas a gravação local falhou.
      // O pendente fica: a próxima resolução repete a chave e recebe o replay, sem novo débito.
      if (!released) {
        const owed = Math.max(0, (res.creditsCharged ?? estimated) - recorded);
        await this.budget.release({ kind, credits: owed, errors: 1, reserved });
        if (owed > 0) await this.quiet(this.pending.setRecorded(pending.id, recorded + owed));
      }
      const msg = (err as Error).message;
      this.logger.warn(`Lote DotCompany não gravado (${chunk.gtins.length} EANs): ${msg}`);
      for (const ean of chunk.gtins) setFor(ean, { status: 'error', reason: msg });
    }
  }

  /**
   * A chamada ao lote falhou. O cliente não repete lote sozinho: o desfecho chega aqui como foi.
   * - timeout/rede: resultado incerto (pode ter cobrado). Lança o estimado uma vez; o lote fica pendente.
   * - 5xx: a DotCompany não cobra erro. Nada lançado; o lote fica pendente (a chave segue reservada lá).
   * - 429: janela bloqueada pelo controlador, EANs `blocked/rate_window`, nada lançado; o lote fica pendente.
   * - 409: ver `onIdempotencyConflict`. 402, 401/403 e outros 4xx: conclusivos, pendente apagado.
   * Em todos os casos que mantêm o pendente, a repetição usa a MESMA chave.
   */
  private async onBatchFailure(err: unknown, a: Attempt): Promise<boolean> {
    const { chunk, pending, rest, ctx, reserved, estimated } = a;
    const { kind } = ctx;
    if (err instanceof DotcompanyIdempotencyError) return this.onIdempotencyConflict(err, a);

    if (isUncertainFailure(err)) {
      const first = pending.creditsRecorded === null;
      await this.budget.release({ kind, errors: 1, credits: first ? estimated : 0, reserved });
      if (first) await this.quiet(this.pending.setRecorded(pending.id, estimated));
      await this.keepPending(a, uncertainOutcome(err), (err as Error).message);
    } else if (
      err instanceof DotcompanyTransientError ||
      err instanceof DotcompanyRateLimitedError
    ) {
      await this.budget.release({ kind, errors: 1, reserved });
      await this.keepPending(
        a,
        err instanceof DotcompanyTransientError ? 'http_5xx' : 'http_4xx',
        (err as Error).message,
      );
    } else {
      await this.quiet(this.pending.remove(pending.id));
      await this.budget.release({ kind, errors: 1, reserved });
    }
    return this.handleBatchError(err, chunk.gtins, rest, ctx);
  }

  /** Mantém o lote pendente com o desfecho; abandona (e acerta o custo) depois de muitas chamadas sem resposta. */
  private async keepPending(
    a: Attempt,
    outcome: PendingBatchOutcome,
    message: string,
  ): Promise<void> {
    const { pending } = a;
    if (pending.attempts >= PENDING_BATCH_MAX_ATTEMPTS) {
      this.logger.warn(
        `Lote DotCompany abandonado após ${pending.attempts} chamadas sem resposta.`,
      );
      await this.settleDeadKey(pending, outcome);
      await this.quiet(this.pending.remove(pending.id));
    } else {
      await this.quiet(this.pending.setOutcome(pending.id, outcome, message));
    }
  }

  /**
   * A chave não será mais usada. Se o último desfecho conhecido foi resposta 4xx/5xx, o lote NÃO foi cobrado:
   * o estimado lançado antes (por um timeout) é desfeito. Se foi timeout/rede, não dá para saber: mantém o
   * estimado (conservador).
   */
  private async settleDeadKey(
    pending: PendingBatchRow,
    lastOutcome: PendingBatchOutcome | null,
  ): Promise<void> {
    const recorded = pending.creditsRecorded ?? 0;
    if (recorded <= 0) return;
    if (lastOutcome === 'http_5xx' || lastOutcome === 'http_4xx') {
      this.logger.log(
        `Chave descartada após ${lastOutcome}: estimado de ${recorded} créditos desfeito.`,
      );
      await this.quiet(this.budget.refundCredits(recorded));
    } else {
      this.logger.warn(
        `Chave descartada com resultado incerto (${lastOutcome ?? 'sem desfecho'}): estimado de ${recorded} créditos mantido.`,
      );
    }
  }

  /**
   * 409 de idempotência.
   * - `IDEMPOTENCY_IN_FLIGHT` (e qualquer 409 desconhecido): o servidor ainda processa. NÃO é chave morta:
   *   o pendente continua com a mesma chave, é reenviado depois de `IN_FLIGHT_RETRY_MS`, e os EANs ficam
   *   `blocked/batch_in_flight`. Nada é lançado.
   * - `IDEMPOTENCY_KEY_ORPHANED`: a única que autoriza chave nova. Se o último desfecho conhecido foi 4xx/5xx
   *   o estimado lançado antes é desfeito; se foi timeout/rede, é mantido.
   * - `IDEMPOTENCY_KEY_CONFLICT`: bug nosso (corpo diferente com a mesma chave); log, nada lançado, chave nova.
   */
  private async onIdempotencyConflict(
    err: DotcompanyIdempotencyError,
    a: Attempt,
  ): Promise<boolean> {
    const { chunk, pending, rest, ctx, reserved, fresh } = a;
    if (!err.keyConflict && !err.orphaned) {
      const retryAt = new Date(this.now().getTime() + IN_FLIGHT_RETRY_MS);
      this.logger.warn(
        `Lote DotCompany ainda em processamento (${err.errorCode}); reenvio com a mesma chave.`,
      );
      await this.budget.release({ kind: ctx.kind, credits: 0, reserved });
      await this.quiet(this.pending.deferInFlight(pending.id, retryAt, err.message));
      this.deferBatches([{ eans: chunk.gtins, retryAt }], ctx);
      return false;
    }
    if (err.keyConflict) {
      this.logger.error(`Idempotency-Key reutilizada com corpo diferente (bug): ${err.message}`);
    } else {
      this.logger.warn(
        `Chave de idempotência órfã (${err.errorCode}); lote reenviado com chave nova.`,
      );
      await this.settleDeadKey(pending, pending.lastOutcome);
    }
    await this.budget.release({ kind: ctx.kind, errors: 1, reserved });
    await this.quiet(this.pending.remove(pending.id));
    if (!fresh) return this.fetchChunk({ gtins: chunk.gtins, pending: null }, rest, ctx, true);
    return this.handleBatchError(err, chunk.gtins, rest, ctx);
  }

  /** Falha de gravação do pendente não derruba a resolução (o pior caso é uma chave a menos para repetir). */
  private async quiet(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch (err) {
      this.logger.warn(`Lote pendente DotCompany: ${(err as Error).message}`);
    }
  }

  /** Falha da chamada ao lote → resultado por EAN. `true` = parar os próximos lotes. */
  private async handleBatchError(
    err: unknown,
    chunk: string[],
    rest: string[],
    ctx: ResolveCtx,
  ): Promise<boolean> {
    const { summary, setFor } = ctx;
    if (err instanceof DotcompanyNoCreditError) {
      await this.budget.onNoCredit();
      summary.blocked = {
        reason: 'no_credit',
        retryAt: null,
        message: 'Sem crédito na DotCompany.',
      };
      for (const ean of rest)
        setFor(ean, { status: 'blocked', blockReason: 'no_credit', reason: 'sem crédito' });
      return true;
    }
    if (err instanceof DotcompanyRateLimitedError) {
      this.budget.onRateLimited(err.retryAfterSec, err.rate);
      const retryAt = new Date(this.now().getTime() + err.retryAfterSec * 1000);
      summary.blocked = {
        reason: 'rate_window',
        retryAt,
        message: 'Janela por minuto da DotCompany esgotada.',
      };
      for (const ean of rest)
        setFor(ean, {
          status: 'blocked',
          blockReason: 'rate_window',
          retryAt,
          reason: 'limite por minuto',
        });
      return true;
    }
    if (err instanceof DotcompanyAuthError) {
      summary.authError = err.message;
      for (const ean of rest)
        setFor(ean, { status: 'error', reason: 'credencial DotCompany recusada' });
      return true;
    }
    const msg = (err as Error).message;
    this.logger.warn(`Lote DotCompany falhou (${chunk.length} EANs): ${msg}`);
    await this.markError(chunk, msg);
    for (const ean of chunk) setFor(ean, { status: 'error', reason: msg });
    return false;
  }

  /**
   * Reconsulta 1 EAN encontrado com o ETag guardado (renova a URL assinada da
   * foto quando ela expirou). 304 mantém o cache e renova a data, sem custo.
   * O GET único não tem `Idempotency-Key` na API: se a resposta se perder, o
   * custo estimado (4 créditos) é lançado e a chamada NÃO é repetida sozinha.
   * Nenhum prazo de chamador cancela esta consulta paga.
   */
  async refreshOne(
    ean: string,
    options: { kind: ConsumerKind },
  ): Promise<{
    status: 'updated' | 'not_modified' | 'blocked' | 'error';
    lookup: DotcompanyLookup | null;
    reason?: string;
  }> {
    const current = (await this.findCached([ean])).get(ean) ?? null;
    const auth = await this.budget.acquire({
      kind: options.kind,
      estimatedCredits: CREDITS_PER_FOUND,
    });
    if (!auth.ok) return { status: 'blocked', lookup: current, reason: auth.message ?? undefined };
    let released = false;
    try {
      const res = await this.client.lookupSingle(ean, { etag: current?.etag ?? null });
      const now = this.now();
      if (res.notModified) {
        released = true;
        await this.budget.release({
          kind: options.kind,
          credits: 0,
          rate: res.rate,
          reserved: auth.reserved,
        });
        await this.dataSource.query(
          `UPDATE dotcompany_lookups SET "fetchedAt" = $2, "updatedAt" = now() WHERE ean = $1`,
          [ean, now],
        );
        return { status: 'not_modified', lookup: (await this.findCached([ean])).get(ean) ?? null };
      }
      const found = Boolean(res.item?.encontrado && res.item.produto);
      const credits = res.creditsCharged ?? (found ? CREDITS_PER_FOUND : 0);
      released = true;
      await this.budget.release({
        kind: options.kind,
        credits,
        found: found ? 1 : 0,
        notFound: found ? 0 : 1,
        rate: res.rate,
        reserved: auth.reserved,
      });
      await this.upsert(ean, res.item, found, now, res.etag);
      return { status: 'updated', lookup: (await this.findCached([ean])).get(ean) ?? null };
    } catch (err) {
      if (!released) {
        await this.budget.release({
          kind: options.kind,
          errors: 1,
          // Sem resposta conclusiva a consulta pode ter sido cobrada. O GET repete sozinho no cliente, então
          // um 5xx final pode vir depois de um timeout: continua conservador (4 créditos).
          credits:
            isUncertainFailure(err) || err instanceof DotcompanyTransientError
              ? CREDITS_PER_FOUND
              : 0,
          reserved: auth.reserved,
        });
      }
      if (err instanceof DotcompanyNoCreditError) await this.budget.onNoCredit();
      if (err instanceof DotcompanyRateLimitedError)
        this.budget.onRateLimited(err.retryAfterSec, err.rate);
      return { status: 'error', lookup: current, reason: (err as Error).message };
    }
  }

  /** Grava o resultado do lote no cache e devolve os EANs encontrados. */
  private async storeBatch(
    chunk: string[],
    items: DotcompanyLookupItem[],
    now: Date,
  ): Promise<string[]> {
    const byGtin = new Map<string, DotcompanyLookupItem>();
    for (const item of items) {
      const c = classifyEan(item.gtin);
      byGtin.set(c.ean || item.gtin, item);
    }
    const found: string[] = [];
    for (let idx = 0; idx < chunk.length; idx++) {
      const ean = chunk[idx];
      // Pelo GTIN devolvido; na falta dele, pela ordem (a DotCompany preserva a ordem da entrada).
      const item =
        byGtin.get(ean) ?? (items.length === chunk.length ? items[idx] : undefined) ?? null;
      const ok = Boolean(item?.encontrado && item.produto);
      if (ok) found.push(ean);
      await this.upsert(ean, item, ok, now, null);
    }
    return found;
  }

  private async upsert(
    ean: string,
    item: DotcompanyLookupItem | null,
    found: boolean,
    now: Date,
    etag: string | null,
  ): Promise<void> {
    const retryAfter = found ? null : new Date(now.getTime() + NOT_FOUND_RETRY_DAYS * 86_400_000);
    await this.dataSource.query(
      `INSERT INTO dotcompany_lookups (ean, status, raw, etag, "fetchedAt", "retryAfter", "lastError")
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, NULL)
       ON CONFLICT (ean) DO UPDATE SET
         status = EXCLUDED.status,
         raw = EXCLUDED.raw,
         etag = COALESCE(EXCLUDED.etag, dotcompany_lookups.etag),
         "fetchedAt" = EXCLUDED."fetchedAt",
         "retryAfter" = EXCLUDED."retryAfter",
         "lastError" = NULL,
         "updatedAt" = now()`,
      [
        ean,
        found ? 'found' : 'not_found',
        item ? JSON.stringify(item) : null,
        etag,
        now,
        retryAfter,
      ],
    );
  }

  private async markError(eans: string[], message: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO dotcompany_lookups (ean, status, "lastError")
       SELECT unnest($1::varchar[]), 'error', $2
       ON CONFLICT (ean) DO UPDATE SET "lastError" = EXCLUDED."lastError", "updatedAt" = now()
         WHERE dotcompany_lookups.status <> 'found'`,
      [eans, message.slice(0, 1000)],
    );
  }
}
