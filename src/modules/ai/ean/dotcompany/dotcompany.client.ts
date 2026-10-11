import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DotcompanyLookupItem } from './dotcompany.types';

export const DEFAULT_DOTCOMPANY_BASE_URL = 'https://erp.dotcompany.com.br/api/v1';
export const DOTCOMPANY_BATCH_MAX = 100;

const REQUEST_TIMEOUT_MS = 15_000;
const TRANSIENT_BACKOFF_MS = [2_000, 4_000, 8_000];
/** 429 com espera curta é repetido aqui; acima disso quem decide é o controlador de consumo. */
const INLINE_RATE_RETRY_MAX_SEC = 5;

/** Leitura dos headers de janela por minuto (`X-RateLimit-*`). */
export interface RateInfo {
  limit: number | null;
  remaining: number | null;
  /** Epoch (segundos) em que a janela renova. */
  reset: number | null;
}

export interface CallMeta {
  status: number;
  /** Créditos cobrados segundo o header; null quando a DotCompany não informou. */
  creditsCharged: number | null;
  rate: RateInfo | null;
  requestId: string | null;
}

export interface BatchResult extends CallMeta {
  items: DotcompanyLookupItem[];
}

export interface SingleResult extends CallMeta {
  /** 304 = nada mudou desde o ETag enviado. */
  notModified: boolean;
  item: DotcompanyLookupItem | null;
  etag: string | null;
}

export interface UsageResult extends CallMeta {
  /** Créditos disponíveis (1 crédito = R$ 0,01). */
  available: number;
  lowBalance: boolean;
}

export class DotcompanyError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errorCode: string | null,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 402: saldo insuficiente. O dado não foi entregue e nada foi cobrado. */
export class DotcompanyNoCreditError extends DotcompanyError {}
/** 401/403 ou token ausente: não adianta repetir. */
export class DotcompanyAuthError extends DotcompanyError {}
/** 429 com espera maior que a tolerada aqui. */
export class DotcompanyRateLimitedError extends DotcompanyError {
  constructor(
    message: string,
    readonly retryAfterSec: number,
    readonly rate: RateInfo | null,
    errorCode: string | null,
    requestId: string | null,
  ) {
    super(message, 429, errorCode, requestId);
  }
}
/** 5xx, timeout ou rede depois das tentativas. */
export class DotcompanyTransientError extends DotcompanyError {}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });

function intHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Junta o timeout da chamada com o sinal de quem chamou (AbortSignal.any não existe no Node 18). */
function combinedSignal(
  timeoutMs: number,
  outer?: AbortSignal,
): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout de ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ctrl.abort(outer?.reason ?? new Error('aborted'));
  if (outer?.aborted) onAbort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Cliente HTTP fino da API DotCompany (catálogo GTIN e consumo).
 *
 * O token vem só da configuração do backend e NUNCA vai para log, erro ou
 * resposta. Não decide orçamento: quem chama passa antes pelo controlador de
 * consumo (DotcompanyBudgetService) e repassa a ele o `CallMeta` de volta.
 */
@Injectable()
export class DotcompanyClient {
  private readonly logger = new Logger(DotcompanyClient.name);
  private readonly token: string | null;
  private readonly baseUrl: string;
  /** Substituíveis em teste. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  sleep: Sleep = defaultSleep;

  constructor(configService: ConfigService) {
    const token = configService.get<string>('DOTCOMPANY_API_TOKEN')?.trim();
    this.token = token ? token : null;
    this.baseUrl = (
      configService.get<string>('DOTCOMPANY_BASE_URL') || DEFAULT_DOTCOMPANY_BASE_URL
    ).replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return this.token !== null;
  }

  /** Consulta até 100 GTINs (cobra por item ENCONTRADO). */
  async lookupBatch(
    gtins: string[],
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<BatchResult> {
    if (gtins.length === 0 || gtins.length > DOTCOMPANY_BATCH_MAX) {
      throw new Error(
        `Lote DotCompany precisa de 1 a ${DOTCOMPANY_BATCH_MAX} GTINs (veio ${gtins.length}).`,
      );
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const { body, meta } = await this.request('POST', '/catalogo/gtin/batch', {
      headers,
      body: JSON.stringify({ gtins }),
      signal: options.signal,
    });
    const itens = (body as { itens?: DotcompanyLookupItem[] } | null)?.itens;
    if (!Array.isArray(itens)) {
      throw new DotcompanyTransientError(
        'Resposta do lote DotCompany sem "itens".',
        meta.status,
        null,
        meta.requestId,
      );
    }
    return { ...meta, items: itens };
  }

  /** Consulta 1 GTIN; com `etag`, um 304 significa "nada mudou" (não cobra). */
  async lookupSingle(
    ean: string,
    options: { etag?: string | null; signal?: AbortSignal } = {},
  ): Promise<SingleResult> {
    const headers: Record<string, string> = {};
    if (options.etag) headers['If-None-Match'] = options.etag;
    const { response, body, meta } = await this.request(
      'GET',
      `/catalogo/gtin/${encodeURIComponent(ean)}`,
      { headers, signal: options.signal },
    );
    const etag = response.headers.get('etag');
    if (response.status === 304) {
      return {
        ...meta,
        creditsCharged: meta.creditsCharged ?? 0,
        notModified: true,
        item: null,
        etag: etag ?? options.etag ?? null,
      };
    }
    const r = body as {
      encontrado?: boolean;
      gtin?: string;
      produto?: DotcompanyLookupItem['produto'];
      codigo_valido?: boolean;
      motivo?: string | null;
      codigo_de_uso_interno?: boolean;
    } | null;
    const item: DotcompanyLookupItem | null = r
      ? {
          gtin: r.gtin ?? ean,
          encontrado: Boolean(r.encontrado),
          produto: r.produto ?? null,
          codigo_valido: r.codigo_valido,
          motivo: r.motivo ?? null,
          codigo_de_uso_interno: r.codigo_de_uso_interno,
        }
      : null;
    return { ...meta, notModified: false, item, etag };
  }

  /** Consumo e saldo da conta (grátis, não conta crédito). */
  async usage(options: { signal?: AbortSignal } = {}): Promise<UsageResult> {
    const { body, meta } = await this.request('GET', '/usage', { signal: options.signal });
    const saldo = (body as { saldo?: { disponivel?: number; credito_baixo?: boolean } } | null)
      ?.saldo;
    if (!saldo || typeof saldo.disponivel !== 'number') {
      throw new DotcompanyTransientError(
        'Resposta de /usage sem saldo.',
        meta.status,
        null,
        meta.requestId,
      );
    }
    return { ...meta, available: saldo.disponivel, lowBalance: Boolean(saldo.credito_baixo) };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ response: Response; body: unknown; meta: CallMeta }> {
    if (!this.token) {
      throw new DotcompanyAuthError(
        'DOTCOMPANY_API_TOKEN não configurado: consulta à DotCompany recusada.',
        null,
        'NO_TOKEN',
        null,
      );
    }
    const url = `${this.baseUrl}${path}`;
    let rateRetried = false;

    for (let attempt = 0; ; attempt++) {
      const { signal, done } = combinedSignal(REQUEST_TIMEOUT_MS, init.signal);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
            ...(init.headers ?? {}),
          },
          body: init.body,
          signal,
        });
      } catch (err) {
        done();
        if (init.signal?.aborted) throw err;
        if (attempt < TRANSIENT_BACKOFF_MS.length) {
          this.logger.warn(
            `DotCompany ${method} ${path}: falha de rede (${(err as Error).message}); nova tentativa.`,
          );
          await this.sleep(TRANSIENT_BACKOFF_MS[attempt], init.signal);
          continue;
        }
        throw new DotcompanyTransientError(
          `DotCompany ${method} ${path}: falha de rede (${(err as Error).message}).`,
          null,
          null,
          null,
        );
      }
      done();

      const meta: CallMeta = {
        status: response.status,
        creditsCharged: intHeader(response.headers, 'x-dotcompany-credits-charged'),
        rate: this.readRate(response.headers),
        requestId: response.headers.get('x-request-id'),
      };
      const errorCode = response.headers.get('x-error-code');

      if (response.ok || response.status === 304) {
        const body = response.status === 304 ? null : await response.json().catch(() => null);
        return { response, body, meta };
      }

      const detail = await this.readDetail(response);
      const msg = `DotCompany ${method} ${path} → ${response.status}${errorCode ? ` ${errorCode}` : ''}${detail ? `: ${detail}` : ''}`;
      this.logger.warn(`${msg} (request_id=${meta.requestId ?? '-'})`);

      if (response.status === 402) {
        throw new DotcompanyNoCreditError(msg, 402, errorCode, meta.requestId);
      }
      if (response.status === 401 || response.status === 403) {
        throw new DotcompanyAuthError(msg, response.status, errorCode, meta.requestId);
      }
      if (response.status === 429) {
        const retryAfter = intHeader(response.headers, 'retry-after') ?? 60;
        if (!rateRetried && retryAfter <= INLINE_RATE_RETRY_MAX_SEC) {
          rateRetried = true;
          await this.sleep(retryAfter * 1000, init.signal);
          attempt--;
          continue;
        }
        throw new DotcompanyRateLimitedError(msg, retryAfter, meta.rate, errorCode, meta.requestId);
      }
      if (response.status >= 500 && attempt < TRANSIENT_BACKOFF_MS.length) {
        await this.sleep(TRANSIENT_BACKOFF_MS[attempt], init.signal);
        continue;
      }
      if (response.status >= 500) {
        throw new DotcompanyTransientError(msg, response.status, errorCode, meta.requestId);
      }
      // Demais 4xx (422 etc.): erro de uso nosso, não adianta repetir.
      throw new DotcompanyError(msg, response.status, errorCode, meta.requestId);
    }
  }

  private readRate(headers: Headers): RateInfo | null {
    const limit = intHeader(headers, 'x-ratelimit-limit');
    const remaining = intHeader(headers, 'x-ratelimit-remaining');
    const reset = intHeader(headers, 'x-ratelimit-reset');
    if (limit === null && remaining === null && reset === null) return null;
    return { limit, remaining, reset };
  }

  private async readDetail(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as { detail?: unknown; code?: unknown };
      const detail = typeof body?.detail === 'string' ? body.detail : null;
      return detail ? detail.slice(0, 300) : null;
    } catch {
      return null;
    }
  }
}
