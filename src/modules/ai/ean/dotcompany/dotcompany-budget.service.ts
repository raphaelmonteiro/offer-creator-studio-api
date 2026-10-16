import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EmailService } from '../../../email/email.service';
import { DotcompanyClient, RateInfo } from './dotcompany.client';
import type { BudgetDenyReason, ConsumerKind } from './dotcompany.types';
import { DotcompanyBalance } from './entities/dotcompany-balance.entity';

export const DOTCOMPANY_BUY_CREDITS_URL = 'https://app.dotcompany.com.br/api-dev/creditos/comprar';

/**
 * Brasil não tem horário de verão desde 2019: America/Sao_Paulo é UTC-3 fixo.
 * Horas e dias de consumo são contados nesse fuso.
 */
const SP_OFFSET_MS = -3 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

/** Início da hora corrente em America/Sao_Paulo. */
export function spHourStart(d: Date): Date {
  const local = d.getTime() + SP_OFFSET_MS;
  return new Date(Math.floor(local / HOUR_MS) * HOUR_MS - SP_OFFSET_MS);
}

/** Início do dia corrente em America/Sao_Paulo (meia-noite local). */
export function spDayStart(d: Date): Date {
  const local = d.getTime() + SP_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - SP_OFFSET_MS);
}

/** Data local (YYYY-MM-DD) em America/Sao_Paulo. */
function spDate(d: Date): string {
  return new Date(d.getTime() + SP_OFFSET_MS).toISOString().slice(0, 10);
}

export interface BudgetLimits {
  rpm: number;
  maxRequestsHour: number;
  maxRequestsDay: number;
  maxCreditsHour: number;
  maxCreditsDay: number;
  reserveCredits: number;
  alertCredits: number;
  balanceRefreshMs: number;
  alertEmail: string | null;
}

/** Autorização do controlador; negada traz o motivo e quando tentar de novo. */
export interface AcquireResult {
  ok: boolean;
  reason: BudgetDenyReason | null;
  retryAt: Date | null;
  message: string | null;
  /** Créditos reservados nos totais até o `release` (devolva-os em `release({ reserved })`). */
  reserved?: number;
}

const ALLOWED: AcquireResult = {
  ok: true,
  reason: null,
  retryAt: null,
  message: null,
  reserved: 0,
};

export interface ReleaseInput {
  kind: ConsumerKind;
  /** Requisições efetivamente feitas (com ou sem sucesso). */
  requests?: number;
  credits?: number;
  found?: number;
  notFound?: number;
  errors?: number;
  rate?: RateInfo | null;
  /** `reserved` devolvido pelo `acquire` desta chamada: libera a reserva em memória. */
  reserved?: number;
}

export interface UsageTotals {
  requests: number;
  credits: number;
  found: number;
  notFound: number;
  errors: number;
}

function intEnv(config: ConfigService, key: string, def: number): number {
  const n = Number.parseInt(config.get<string>(key) ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Controlador único de acesso à API DotCompany (D13).
 *
 * O que a DotCompany limita de fato é a janela de 1 minuto do plano e o saldo;
 * não há teto por hora/dia para chaves `dc_`. Os limites por hora/dia daqui
 * são NOSSOS — trava de orçamento —, persistidos em `dotcompany_usage_hourly`
 * para valerem depois de um restart.
 *
 * Todo consumidor chama `acquire` antes e `release` depois de cada chamada. O
 * encarte (`interactive`) passa na frente: os jobs em lote (`batch`) param
 * quando o saldo chega à reserva.
 */
@Injectable()
export class DotcompanyBudgetService {
  private readonly logger = new Logger(DotcompanyBudgetService.name);
  readonly limits: BudgetLimits;

  /** Relógio injetável para testes. */
  now: () => Date = () => new Date();

  private windowStart = 0;
  private windowCount = 0;
  /** Teto efetivo da janela: o menor entre o configurado e o anunciado pela DotCompany. */
  private effectiveRpm: number;
  private blockedUntil = 0;
  private balance: { available: number | null; checkedAt: Date | null } | null = null;
  private refreshing: Promise<void> | null = null;
  /** Fila das decisões de `acquire`/`peek` (uma de cada vez). */
  private gate: Promise<void> = Promise.resolve();
  /** Autorizado e ainda sem `release`: conta nos limites de hora/dia e no saldo. */
  private reservedRequests = 0;
  private reservedCredits = 0;

  constructor(
    configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly client: DotcompanyClient,
    @Optional() private readonly email?: EmailService,
  ) {
    this.limits = {
      rpm: Math.max(1, intEnv(configService, 'DOTCOMPANY_RPM', 30)),
      maxRequestsHour: intEnv(configService, 'DOTCOMPANY_MAX_REQUESTS_HOUR', 600),
      maxRequestsDay: intEnv(configService, 'DOTCOMPANY_MAX_REQUESTS_DAY', 5000),
      maxCreditsHour: intEnv(configService, 'DOTCOMPANY_MAX_CREDITS_HOUR', 4000),
      maxCreditsDay: intEnv(configService, 'DOTCOMPANY_MAX_CREDITS_DAY', 12000),
      reserveCredits: intEnv(configService, 'DOTCOMPANY_RESERVE_CREDITS', 400),
      alertCredits: intEnv(configService, 'DOTCOMPANY_ALERT_CREDITS', 1000),
      balanceRefreshMs:
        Math.max(1, intEnv(configService, 'DOTCOMPANY_BALANCE_REFRESH_MIN', 15)) * MINUTE_MS,
      alertEmail: configService.get<string>('DOTCOMPANY_ALERT_EMAIL')?.trim() || null,
    };
    this.effectiveRpm = this.limits.rpm;
  }

  /**
   * Pede autorização para UMA chamada. `estimatedCredits` é o pior caso (ex.:
   * 4 × itens do lote). Quando autoriza, já ocupa a vaga na janela do minuto e
   * reserva requisição e créditos nos totais de hora/dia até o `release`
   * correspondente (`reserved`). As decisões são serializadas: chamadas
   * simultâneas nunca passam todas pela mesma vaga.
   */
  async acquire(input: { kind: ConsumerKind; estimatedCredits: number }): Promise<AcquireResult> {
    if (this.client.isConfigured()) await this.ensureFreshBalance();
    return this.exclusive(() => this.evaluate(input, true));
  }

  /** Executa `fn` depois de todas as decisões anteriores terminarem. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let done!: () => void;
    this.gate = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      done();
    }
  }

  private async evaluate(
    input: { kind: ConsumerKind; estimatedCredits: number },
    reserve: boolean,
  ): Promise<AcquireResult> {
    const now = this.now();
    const t = now.getTime();

    if (!this.client.isConfigured()) {
      return this.deny(
        'no_token',
        new Date(t + this.limits.balanceRefreshMs),
        'DOTCOMPANY_API_TOKEN não configurado.',
      );
    }

    if (this.blockedUntil > t) {
      return this.deny(
        'rate_window',
        new Date(this.blockedUntil),
        'Janela por minuto da DotCompany esgotada.',
      );
    }
    const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
    if (minute !== this.windowStart) {
      this.windowStart = minute;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.effectiveRpm) {
      return this.deny(
        'rate_window',
        new Date(minute + MINUTE_MS),
        `Limite de ${this.effectiveRpm} req/min atingido.`,
      );
    }

    const est = Math.max(0, Math.round(input.estimatedCredits));
    const [hour, day] = await Promise.all([
      this.totals(spHourStart(now), HOUR_MS),
      this.totals(spDayStart(now), DAY_MS),
    ]);
    const nextHour = new Date(spHourStart(now).getTime() + HOUR_MS);
    const nextDay = new Date(spDayStart(now).getTime() + DAY_MS);
    // O que já foi autorizado e ainda não teve release também conta.
    const held = { requests: this.reservedRequests, credits: this.reservedCredits };

    if (
      day.requests + held.requests + 1 > this.limits.maxRequestsDay ||
      day.credits + held.credits + est > this.limits.maxCreditsDay
    ) {
      void this.alertDayLimit(now, day);
      return this.deny('day_limit', nextDay, 'Limite diário de consumo DotCompany atingido.');
    }
    if (
      hour.requests + held.requests + 1 > this.limits.maxRequestsHour ||
      hour.credits + held.credits + est > this.limits.maxCreditsHour
    ) {
      return this.deny('hour_limit', nextHour, 'Limite por hora de consumo DotCompany atingido.');
    }

    const available = this.balance?.available ?? null;
    const nextCheck = new Date(t + this.limits.balanceRefreshMs);
    if (available !== null) {
      if (available <= 0) {
        return this.deny('no_credit', nextCheck, 'Sem crédito na DotCompany.');
      }
      if (input.kind === 'batch' && available - held.credits - est < this.limits.reserveCredits) {
        return this.deny(
          'reserve',
          nextCheck,
          `Saldo (${available}) na reserva do encarte (${this.limits.reserveCredits}).`,
        );
      }
    }

    if (reserve) {
      this.windowCount += 1;
      this.reservedRequests += 1;
      this.reservedCredits += est;
    }
    return { ...ALLOWED, reserved: reserve ? est : 0 };
  }

  /** Registra o resultado de uma chamada autorizada (sucesso ou erro). */
  async release(input: ReleaseInput): Promise<void> {
    try {
      await this.recordUsage(input);
    } finally {
      // Só depois de gravar o consumo: a reserva em memória cede lugar ao contador do banco.
      if (input.reserved !== undefined) {
        this.reservedRequests = Math.max(0, this.reservedRequests - 1);
        this.reservedCredits = Math.max(0, this.reservedCredits - input.reserved);
      }
    }
  }

  /**
   * Desfaz créditos estimados que se mostraram sem cobrança (a DotCompany não cobra 5xx/4xx).
   * - Serializado com `acquire`/`peek` (mesma fila): não corre com as decisões do controlador.
   * - Tira da HORA em que o estimado foi lançado (`recordedAt`), com piso zero atômico
   *   (`GREATEST(credits - x, 0)`): dois estornos concorrentes nunca deixam contador negativo.
   * - Saldo local: só recebe o valor de volta se NÃO foi conferido na DotCompany depois do lançamento
   *   (`checkedAt` > `recordedAt`: o `/usage` já reflete o real). Se o saldo voltar acima do limiar, os
   *   alertas são rearmados.
   */
  async refundCredits(credits: number, recordedAt: Date): Promise<void> {
    const amount = Math.max(0, Math.round(credits));
    if (amount === 0) return;
    await this.exclusive(async () => {
      await this.dataSource.query(
        `UPDATE dotcompany_usage_hourly SET credits = GREATEST(credits - $2, 0) WHERE hour = $1`,
        [spHourStart(recordedAt), amount],
      );
      const before = (await this.loadBalance()).available;
      const rows = (await this.dataSource.query(
        `UPDATE dotcompany_balance SET available = available + $1
          WHERE id = 1 AND available IS NOT NULL AND ("checkedAt" IS NULL OR "checkedAt" <= $2)
        RETURNING available`,
        [amount, recordedAt],
      )) as [Array<{ available: number }>, number] | Array<{ available: number }>;
      // UPDATE ... RETURNING: o driver devolve `[linhas, quantidade]`.
      const updated = Array.isArray(rows[0]) ? rows[0] : (rows as Array<{ available: number }>);
      if (updated.length === 0) return;
      const after = Number(updated[0].available);
      if (this.balance) this.balance.available = after;
      await this.checkBalanceAlerts(before, after);
    });
  }

  private async recordUsage(input: ReleaseInput): Promise<void> {
    const now = this.now();
    const requests = input.requests ?? 1;
    const credits = Math.max(0, Math.round(input.credits ?? 0));
    await this.dataSource.query(
      `INSERT INTO dotcompany_usage_hourly
         (hour, requests, credits, found, "notFound", errors, "interactiveRequests", "batchRequests")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hour) DO UPDATE SET
         requests = dotcompany_usage_hourly.requests + EXCLUDED.requests,
         credits = dotcompany_usage_hourly.credits + EXCLUDED.credits,
         found = dotcompany_usage_hourly.found + EXCLUDED.found,
         "notFound" = dotcompany_usage_hourly."notFound" + EXCLUDED."notFound",
         errors = dotcompany_usage_hourly.errors + EXCLUDED.errors,
         "interactiveRequests" = dotcompany_usage_hourly."interactiveRequests" + EXCLUDED."interactiveRequests",
         "batchRequests" = dotcompany_usage_hourly."batchRequests" + EXCLUDED."batchRequests"`,
      [
        spHourStart(now),
        requests,
        credits,
        input.found ?? 0,
        input.notFound ?? 0,
        input.errors ?? 0,
        input.kind === 'interactive' ? requests : 0,
        input.kind === 'batch' ? requests : 0,
      ],
    );

    if (credits > 0) {
      await this.dataSource.query(
        `UPDATE dotcompany_balance SET available = GREATEST(available - $1, 0) WHERE id = 1 AND available IS NOT NULL`,
        [credits],
      );
      if (this.balance?.available != null) {
        const before = this.balance.available;
        this.balance.available = Math.max(before - credits, 0);
        await this.checkBalanceAlerts(before, this.balance.available);
      }
    }

    this.applyRate(input.rate ?? null, now);
  }

  /** A DotCompany respondeu 429: nada passa até `retryAfterSec`. */
  onRateLimited(retryAfterSec: number, rate?: RateInfo | null): void {
    const until = this.now().getTime() + Math.max(1, retryAfterSec) * 1000;
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.applyRate(rate ?? null, this.now());
  }

  /** A DotCompany respondeu 402: saldo zero até uma consulta de saldo mostrar crédito. */
  async onNoCredit(): Promise<void> {
    const before = this.balance?.available ?? null;
    await this.saveBalance(0, this.now());
    await this.checkBalanceAlerts(before, 0);
    // Confere logo em seguida: o 402 pode ter vindo de um lote maior que o saldo.
    void this.refreshBalance().catch(() => undefined);
  }

  /** Força a leitura do saldo na DotCompany (`GET /usage`, grátis). */
  async refreshBalance(): Promise<{ available: number | null; checkedAt: Date | null }> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const before = (await this.loadBalance()).available;
          const usage = await this.client.usage();
          await this.saveBalance(Math.round(usage.available), this.now());
          await this.checkBalanceAlerts(before, Math.round(usage.available));
        } finally {
          this.refreshing = null;
        }
      })();
    }
    await this.refreshing;
    return this.loadBalance();
  }

  /** Relatório para a rota admin. */
  async report(): Promise<{
    balance: { available: number | null; checkedAt: Date | null };
    hour: UsageTotals;
    day: UsageTotals;
    month: UsageTotals;
    limits: Omit<BudgetLimits, 'alertEmail'> & {
      effectiveRpm: number;
      alertEmailConfigured: boolean;
    };
    state: 'ok' | 'limited' | 'no_credit' | 'no_token';
    reason: BudgetDenyReason | null;
    retryAt: Date | null;
    message: string | null;
  }> {
    const now = this.now();
    const local = new Date(now.getTime() + SP_OFFSET_MS);
    const monthStart = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SP_OFFSET_MS,
    );
    const [hour, day, month, balance] = await Promise.all([
      this.totals(spHourStart(now), HOUR_MS),
      this.totals(spDayStart(now), DAY_MS),
      this.totalsBetween(monthStart, now),
      this.loadBalance(),
    ]);
    const probe = await this.peek({ kind: 'interactive', estimatedCredits: 4 });
    const { alertEmail, ...limits } = this.limits;
    return {
      balance,
      hour,
      day,
      month,
      limits: {
        ...limits,
        effectiveRpm: this.effectiveRpm,
        alertEmailConfigured: Boolean(alertEmail),
      },
      state: probe.ok
        ? 'ok'
        : probe.reason === 'no_credit'
          ? 'no_credit'
          : probe.reason === 'no_token'
            ? 'no_token'
            : 'limited',
      reason: probe.ok ? null : probe.reason,
      retryAt: probe.ok ? null : probe.retryAt,
      message: probe.ok ? null : probe.message,
    };
  }

  /** Mesmo julgamento de `acquire`, sem ocupar vaga nem reservar nada. */
  async peek(input: { kind: ConsumerKind; estimatedCredits: number }): Promise<AcquireResult> {
    if (this.client.isConfigured()) await this.ensureFreshBalance();
    return this.exclusive(() => this.evaluate(input, false));
  }

  private deny(reason: BudgetDenyReason, retryAt: Date | null, message: string): AcquireResult {
    return { ok: false, reason, retryAt, message };
  }

  private applyRate(rate: RateInfo | null, now: Date): void {
    if (!rate) return;
    if (rate.limit !== null && rate.limit > 0) {
      this.effectiveRpm = Math.min(this.limits.rpm, rate.limit);
    }
    if (rate.remaining !== null && rate.remaining <= 0) {
      const reset = rate.reset !== null ? rate.reset * 1000 : now.getTime() + MINUTE_MS;
      this.blockedUntil = Math.max(this.blockedUntil, reset);
    }
  }

  private async totals(from: Date, spanMs: number): Promise<UsageTotals> {
    return this.totalsBetween(from, new Date(from.getTime() + spanMs - 1));
  }

  private async totalsBetween(from: Date, to: Date): Promise<UsageTotals> {
    const [row]: Array<Record<keyof UsageTotals, number>> = await this.dataSource.query(
      `SELECT COALESCE(SUM(requests), 0)::int AS requests,
              COALESCE(SUM(credits), 0)::int AS credits,
              COALESCE(SUM(found), 0)::int AS found,
              COALESCE(SUM("notFound"), 0)::int AS "notFound",
              COALESCE(SUM(errors), 0)::int AS errors
         FROM dotcompany_usage_hourly
        WHERE hour >= $1 AND hour <= $2`,
      [from, to],
    );
    return {
      requests: row?.requests ?? 0,
      credits: row?.credits ?? 0,
      found: row?.found ?? 0,
      notFound: row?.notFound ?? 0,
      errors: row?.errors ?? 0,
    };
  }

  private async loadBalance(): Promise<{ available: number | null; checkedAt: Date | null }> {
    const row = await this.dataSource
      .getRepository(DotcompanyBalance)
      .findOne({ where: { id: 1 } });
    this.balance = { available: row?.available ?? null, checkedAt: row?.checkedAt ?? null };
    return { ...this.balance };
  }

  private async saveBalance(available: number, checkedAt: Date): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO dotcompany_balance (id, available, "checkedAt") VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET available = EXCLUDED.available, "checkedAt" = EXCLUDED."checkedAt"`,
      [available, checkedAt],
    );
    this.balance = { available, checkedAt };
  }

  /** Recarrega o saldo do banco e, se estiver velho, da DotCompany. Falha de rede não bloqueia. */
  private async ensureFreshBalance(): Promise<void> {
    const b = this.balance ?? (await this.loadBalance());
    const stale =
      !b.checkedAt ||
      this.now().getTime() - new Date(b.checkedAt).getTime() >= this.limits.balanceRefreshMs;
    if (!stale) return;
    try {
      await this.refreshBalance();
    } catch (err) {
      this.logger.warn(`Não consegui conferir o saldo DotCompany: ${(err as Error).message}`);
    }
  }

  /** Saldo baixo (com histerese) e saldo zerado: um e-mail por ocorrência. */
  private async checkBalanceAlerts(before: number | null, after: number): Promise<void> {
    const threshold = this.limits.alertCredits;
    const now = this.now();
    if (after > threshold) {
      // Voltou acima do limiar: rearma os alertas.
      await this.dataSource.query(
        `UPDATE dotcompany_balance SET "lowAlertSentAt" = NULL, "emptyAlertSentAt" = NULL WHERE id = 1`,
      );
      return;
    }
    const row = await this.dataSource
      .getRepository(DotcompanyBalance)
      .findOne({ where: { id: 1 } });
    if (after <= 0) {
      if (row?.emptyAlertSentAt) return;
      await this.dataSource.query(
        `UPDATE dotcompany_balance SET "emptyAlertSentAt" = $1 WHERE id = 1`,
        [now],
      );
      await this.sendAlert('Saldo DotCompany zerado', 'O saldo de créditos da DotCompany acabou.', [
        'As consultas por EAN estão paradas: os encartes seguem pelo casamento por nome e as importações em lote esperam.',
        `Compre créditos em ${DOTCOMPANY_BUY_CREDITS_URL}. As importações voltam sozinhas quando o saldo for conferido.`,
      ]);
      return;
    }
    if (row?.lowAlertSentAt) return;
    if (before !== null && before <= threshold) return;
    await this.dataSource.query(
      `UPDATE dotcompany_balance SET "lowAlertSentAt" = $1 WHERE id = 1`,
      [now],
    );
    const day = await this.totals(spDayStart(now), DAY_MS);
    await this.sendAlert(
      'Saldo DotCompany baixo',
      `Restam ${after} créditos (R$ ${(after / 100).toFixed(2)}) na DotCompany.`,
      [
        `Consumo de hoje: ${day.requests} requisições, ${day.credits} créditos.`,
        `Com ${this.limits.reserveCredits} créditos ou menos, as importações em lote param para reservar o saldo aos encartes.`,
        `Compre créditos em ${DOTCOMPANY_BUY_CREDITS_URL}.`,
      ],
    );
  }

  private async alertDayLimit(now: Date, day: UsageTotals): Promise<void> {
    try {
      const today = spDate(now);
      const rows = (await this.dataSource.query(
        `INSERT INTO dotcompany_balance (id, "dayLimitAlertDay") VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET "dayLimitAlertDay" = EXCLUDED."dayLimitAlertDay"
           WHERE dotcompany_balance."dayLimitAlertDay" IS DISTINCT FROM EXCLUDED."dayLimitAlertDay"
         RETURNING id`,
        [today],
      )) as unknown[];
      if (rows.length === 0) return;
      await this.sendAlert(
        'Limite diário DotCompany atingido',
        'O limite diário de consumo da DotCompany foi atingido.',
        [
          `Hoje: ${day.requests} requisições, ${day.credits} créditos (limites: ${this.limits.maxRequestsDay} req, ${this.limits.maxCreditsDay} créditos).`,
          'As consultas voltam à meia-noite. Para mudar o limite, ajuste DOTCOMPANY_MAX_*_DAY no .env do backend.',
        ],
      );
    } catch (err) {
      this.logger.warn(`Falha ao registrar alerta de limite diário: ${(err as Error).message}`);
    }
  }

  private async sendAlert(subject: string, headline: string, lines: string[]): Promise<void> {
    this.logger.warn(`[alerta DotCompany] ${headline} ${lines.join(' ')}`);
    if (!this.limits.alertEmail || !this.email) return;
    try {
      await this.email.sendDotcompanyAlert({
        email: this.limits.alertEmail,
        subject,
        headline,
        lines,
      });
    } catch (err) {
      this.logger.warn(`Falha ao enviar e-mail de alerta DotCompany: ${(err as Error).message}`);
    }
  }
}
