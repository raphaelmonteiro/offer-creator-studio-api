import { secondsUntil } from './flyer-pro-retry-after';

const HOUR_MS = 3_600_000;

/**
 * A janela corrida de 60 minutos por chave (o encarte): conta instantes, recusa com `max` ou mais nos últimos 60 minutos e
 * diz quantos segundos faltam até o mais antigo sair. O que se conta é de cada chamador: a sugestão de estrutura (N19) conta
 * só a resposta 200 e a busca de fotos no Google conta cada chamada que saiu para a Serper. Em memória do processo; o
 * relógio é injetável para os testes.
 */
export class HourlyWindow {
  /** Chave -> instantes (ms), do mais antigo para o mais novo. */
  private readonly entries = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `null` quando a chave tem menos de `max` instantes nos últimos 60 minutos; senão os segundos (arredondados para cima)
   * até o mais antigo sair da janela. Só olha: não conta.
   */
  check(key: string, max: number): number | null {
    const now = this.now();
    const recent = this.recentOf(key, now);
    if (recent.length < max) return null;
    return secondsUntil(recent[0] + HOUR_MS, now);
  }

  /** Conta um instante para a chave, depois de esquecer as chaves sem nenhum instante na última hora. */
  record(key: string): void {
    const now = this.now();
    this.sweep(now);
    this.entries.set(key, [...this.recentOf(key, now), now]);
  }

  /** A chave ainda está guardada (tem instante, ainda que velho, até a próxima gravação varrer). */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  private recentOf(key: string, now: number): number[] {
    return (this.entries.get(key) ?? []).filter((at) => now - at < HOUR_MS);
  }

  /** Esquece as chaves sem nenhum instante na última hora, para a memória não crescer sem fim. */
  private sweep(now: number): void {
    for (const [key, times] of this.entries) {
      if (times.every((at) => now - at >= HOUR_MS)) this.entries.delete(key);
    }
  }
}
