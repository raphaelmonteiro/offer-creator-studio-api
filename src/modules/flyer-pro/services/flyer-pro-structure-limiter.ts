import type { StructureAiBusyReason } from '../domain/flyer-pro.errors';
import { HourlyWindow } from './flyer-pro-hourly-window';
import { secondsUntil } from './flyer-pro-retry-after';

/** A recusa de um dos dois freios: o motivo e os segundos (arredondados para cima) até poder tentar de novo. */
export interface StructureRefusal {
  reason: StructureAiBusyReason;
  retryAfterSeconds: number;
}

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
  /** A janela de 60 minutos das sugestões atendidas, por encarte (a peça comum com a busca de fotos). */
  private readonly served: HourlyWindow;
  private lastToken = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.served = new HourlyWindow(now);
  }

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
    const retryAfterSeconds = this.served.check(documentId, max);
    return retryAfterSeconds === null ? null : { reason: 'HOURLY_LIMIT', retryAfterSeconds };
  }

  /** Conta uma sugestão atendida (só a resposta 200: a falha do provedor e a recusa não contam, D-2 (b)). */
  recordServed(documentId: string): void {
    this.served.record(documentId);
  }
}
