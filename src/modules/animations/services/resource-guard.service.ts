import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Admission control (TDD §6.5 camada 2): amostra CPU (/proc/stat no Linux,
 * loadavg como fallback) e RAM livre a cada 5s, média móvel de 30s, com
 * histerese — pausa jobs pesados acima de 80% e só retoma abaixo de 65% por 30s.
 */
@Injectable()
export class ResourceGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResourceGuardService.name);

  static readonly CPU_HIGH = 0.8;
  static readonly CPU_LOW = 0.65;
  static readonly MIN_FREE_MEM_BYTES = 500 * 1024 * 1024;
  private static readonly WINDOW = 6; // 6 amostras × 5s = 30s

  private samples: number[] = [];
  private lowSince: number | null = null;
  private degraded = false;
  private timer: NodeJS.Timeout | null = null;
  private lastCpuTimes: { idle: number; total: number } | null = null;

  onModuleInit(): void {
    this.timer = setInterval(() => this.sample(), 5000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** true = pode iniciar job pesado (render/ingest). Jobs leves nunca passam por aqui. */
  admitHeavyJob(): boolean {
    return !this.degraded;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  /** Exposto para testes: injeta uma amostra e reavalia o estado. */
  evaluate(cpuUsage: number, freeMemBytes: number, now = Date.now()): boolean {
    this.samples.push(cpuUsage);
    if (this.samples.length > ResourceGuardService.WINDOW) this.samples.shift();
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    const memLow = freeMemBytes < ResourceGuardService.MIN_FREE_MEM_BYTES;

    if (!this.degraded) {
      if (avg > ResourceGuardService.CPU_HIGH || memLow) {
        this.degraded = true;
        this.lowSince = null;
        this.logger.warn(`Modo degradado: cpu=${(avg * 100).toFixed(0)}% memLow=${memLow}`);
      }
    } else {
      const recovered = avg < ResourceGuardService.CPU_LOW && !memLow;
      if (recovered) {
        if (this.lowSince === null) this.lowSince = now;
        if (now - this.lowSince >= 30_000) {
          this.degraded = false;
          this.lowSince = null;
          this.logger.log('Recursos recuperados — retomando jobs pesados');
        }
      } else {
        this.lowSince = null;
      }
    }
    return this.degraded;
  }

  private sample(): void {
    this.evaluate(this.readCpuUsage(), os.freemem());
  }

  private readCpuUsage(): number {
    try {
      if (process.platform === 'linux') {
        const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] ?? 0);
        const total = parts.reduce((a, b) => a + b, 0);
        if (this.lastCpuTimes) {
          const dIdle = idle - this.lastCpuTimes.idle;
          const dTotal = total - this.lastCpuTimes.total;
          this.lastCpuTimes = { idle, total };
          return dTotal > 0 ? 1 - dIdle / dTotal : 0;
        }
        this.lastCpuTimes = { idle, total };
        return 0;
      }
    } catch {
      // cai no fallback de loadavg
    }
    return Math.min(1, os.loadavg()[0] / os.cpus().length);
  }
}
