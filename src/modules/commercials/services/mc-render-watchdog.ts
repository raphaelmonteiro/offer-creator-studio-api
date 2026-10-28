/**
 * Carência, depois da morte do Chromium durante o render, para o Remotion retomar sozinho (quadros voltam a
 * andar). Sem progresso nesse prazo o render é cancelado e vira `render_interrupted`, em vez de segurar a fila
 * `mc.render` até o prazo total (~14 min): medido na stack `qa-wc` (corrigir-render-remotion-epipe, 1.6).
 */
export const MC_RENDER_DEATH_GRACE_MS = 60_000;

/**
 * Vigia de UM render: o navegador fechou fora do nosso controle (evento `closed`/`closed-silent` da instância em
 * cache) e os quadros pararam de andar → `cancel()` e `stalledAfterDeath()` fica true para o chamador classificar.
 */
export class RenderDeathWatch {
  private diedAt: number | null = null;
  private lastProgressAt = Date.now();
  private maxProgress = -1;
  private stalled = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly cancel: () => void,
    private readonly graceMs: number = MC_RENDER_DEATH_GRACE_MS,
    checkEveryMs = 5_000,
  ) {
    this.timer = setInterval(() => this.check(), checkEveryMs);
    this.timer.unref?.();
  }

  browserClosed(): void {
    this.diedAt ??= Date.now();
  }

  /** Só conta progresso que AVANÇA: o Remotion volta a chamar `onProgress` com o mesmo valor com o render parado. */
  progressed(progress: number): void {
    if (progress <= this.maxProgress) return;
    this.maxProgress = progress;
    this.lastProgressAt = Date.now();
  }

  /** O navegador morreu durante este render (mesmo que ele tenha se recuperado). */
  browserDied(): boolean {
    return this.diedAt !== null;
  }

  stalledAfterDeath(): boolean {
    return this.stalled;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private check(): void {
    if (this.diedAt === null || this.stalled) return;
    if (Date.now() - Math.max(this.diedAt, this.lastProgressAt) < this.graceMs) return;
    this.stalled = true;
    this.cancel();
  }
}
