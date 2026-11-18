import type { StructureAiBusyReason } from '../domain/flyer-pro.errors';

/** A recusa de um dos dois freios: o motivo e os segundos (arredondados para cima) até poder tentar de novo. */
export interface StructureRefusal {
  reason: StructureAiBusyReason;
  retryAfterSeconds: number;
}

const HOUR_MS = 3_600_000;

/** Segundos até `untilMs`, arredondados para cima e nunca menos de 1. */
const secondsUntil = (untilMs: number, nowMs: number): number =>
  Math.max(1, Math.ceil((untilMs - nowMs) / 1000));

/**
 * Os dois freios da sugestão de estrutura, em memória do processo da API (um provider único do módulo; zeram quando ela
 * reinicia): uma chamada ao provedor em andamento por encarte, de qualquer usuário, e um teto de sugestões atendidas por
 * encarte em 60 minutos corridos. O relógio é injetável para os testes.
 */
export class FlyerProStructureLimiter {
  /** Encarte -> instante (ms) do prazo da chamada em andamento. */
  private readonly inFlight = new Map<string, number>();
  /** Encarte -> instantes (ms) das sugestões atendidas, do mais antigo para o mais novo. */
  private readonly served = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Toma a vaga do encarte para uma chamada de até `timeoutMs`; devolve `null` quando conseguiu, ou a recusa `IN_FLIGHT`
   * com o tempo até o prazo da chamada em andamento. Vaga com prazo vencido não segura ninguém.
   */
  tryAcquire(documentId: string, timeoutMs: number): StructureRefusal | null {
    const now = this.now();
    const deadline = this.inFlight.get(documentId);
    if (deadline !== undefined && deadline > now) {
      return { reason: 'IN_FLIGHT', retryAfterSeconds: secondsUntil(deadline, now) };
    }
    this.inFlight.set(documentId, now + timeoutMs);
    return null;
  }

  /** Solta a vaga, em qualquer fim da chamada ao provedor (sucesso, falha ou prazo); soltar de novo não faz nada. */
  release(documentId: string): void {
    this.inFlight.delete(documentId);
  }

  /**
   * `HOURLY_LIMIT` quando o encarte já tem `max` sugestões atendidas nos últimos 60 minutos, com o tempo até a mais
   * antiga sair da janela; senão `null`.
   */
  checkHourly(documentId: string, max: number): StructureRefusal | null {
    const now = this.now();
    const recent = this.recentOf(documentId, now);
    if (recent.length < max) return null;
    return { reason: 'HOURLY_LIMIT', retryAfterSeconds: secondsUntil(recent[0] + HOUR_MS, now) };
  }

  /** Conta uma sugestão atendida (só a resposta 200: a falha do provedor e a recusa não contam, D-2 (b)). */
  recordServed(documentId: string): void {
    const now = this.now();
    this.sweep(now);
    this.served.set(documentId, [...this.recentOf(documentId, now), now]);
  }

  private recentOf(documentId: string, now: number): number[] {
    return (this.served.get(documentId) ?? []).filter((at) => now - at < HOUR_MS);
  }

  /** Esquece os encartes sem nenhuma sugestão na última hora, para a memória não crescer sem fim. */
  private sweep(now: number): void {
    for (const [documentId, times] of this.served) {
      if (times.every((at) => now - at >= HOUR_MS)) this.served.delete(documentId);
    }
  }
}
