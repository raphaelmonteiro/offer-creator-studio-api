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

/** A vaga dada: só quem tem o `token` consegue soltá-la. */
export interface StructureSlot {
  token: number;
}

interface HeldSlot extends StructureSlot {
  /** Instante (ms) em que a chamada deveria acabar; só serve para o `retryAfterSeconds` da recusa. */
  deadline: number;
}

/** `true` quando o resultado de `tryAcquire` é a recusa e não a vaga. */
export const isRefusal = (result: StructureSlot | StructureRefusal): result is StructureRefusal =>
  'reason' in result;

/**
 * Os dois freios da sugestão de estrutura, em memória do processo da API (um provider único do módulo; zeram quando ela
 * reinicia): uma chamada ao provedor em andamento por encarte, de qualquer usuário, e um teto de sugestões atendidas por
 * encarte em 60 minutos corridos. O relógio é injetável para os testes.
 */
export class FlyerProStructureLimiter {
  /** Encarte -> a vaga da chamada em andamento. */
  private readonly inFlight = new Map<string, HeldSlot>();
  /** Encarte -> instantes (ms) das sugestões atendidas, do mais antigo para o mais novo. */
  private readonly served = new Map<string, number[]>();
  private lastToken = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Toma a vaga do encarte para uma chamada de até `timeoutMs`; devolve a vaga (com o token para soltá-la) ou a recusa
   * `IN_FLIGHT` com o tempo até o prazo da chamada em andamento. A vaga fica presa até o dono soltá-la: o relógio não a
   * vence, porque a chamada ao provedor pode seguir (e custar) depois do prazo contado aqui.
   */
  tryAcquire(documentId: string, timeoutMs: number): StructureSlot | StructureRefusal {
    const now = this.now();
    const held = this.inFlight.get(documentId);
    if (held) return { reason: 'IN_FLIGHT', retryAfterSeconds: secondsUntil(held.deadline, now) };
    this.lastToken += 1;
    this.inFlight.set(documentId, { token: this.lastToken, deadline: now + timeoutMs });
    return { token: this.lastToken };
  }

  /** Solta a vaga só se ainda for a do `token` (a de uma chamada mais nova não é solta pela antiga); soltar de novo não faz nada. */
  release(documentId: string, token: number): void {
    if (this.inFlight.get(documentId)?.token === token) this.inFlight.delete(documentId);
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
