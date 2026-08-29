import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type DegradedReason = 'cpu' | 'ram' | 'disk';

export interface ResourceGuardState {
  degraded: boolean;
  /** Motivo que disparou a degradação (prioridade cpu > ram > disk); null quando saudável. */
  reason: DegradedReason | null;
}

/**
 * Admission control (TDD §6.5 camada 2) — infraestrutura compartilhada
 * (plano-comerciais §11): amostra CPU (/proc/stat no Linux, loadavg como
 * fallback), RAM livre e espaço livre no filesystem de UPLOAD_DEST a cada 5s,
 * média móvel de 30s de CPU, com histerese — pausa jobs pesados acima de 80%
 * de CPU, <500MB de RAM livre ou disco abaixo do mínimo, e só retoma quando
 * TODOS os recursos ficam saudáveis por 30s sustentados.
 */
@Injectable()
export class ResourceGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResourceGuardService.name);

  static readonly CPU_HIGH = 0.8;
  static readonly CPU_LOW = 0.65;
  static readonly DEFAULT_MIN_FREE_MEM_MB = 500;
  static readonly DEFAULT_MIN_DISK_GB = 5;

  /**
   * Piso de RAM livre em bytes (env RESOURCE_GUARD_MIN_FREE_MEM_MB, default 500).
   * Configurável porque `os.freemem()` no Linux reporta MemFree (sem contar
   * page cache) — em containers de dev isso fica abaixo de 500MB com o sistema
   * saudável, travando os jobs pesados em loop silencioso de expire.
   */
  static minFreeMemBytes(): number {
    const mb = Number(process.env.RESOURCE_GUARD_MIN_FREE_MEM_MB);
    const effective =
      Number.isFinite(mb) && mb > 0 ? mb : ResourceGuardService.DEFAULT_MIN_FREE_MEM_MB;
    return effective * 1024 * 1024;
  }
  private static readonly WINDOW = 6; // 6 amostras × 5s = 30s

  private samples: number[] = [];
  private lowSince: number | null = null;
  private degraded = false;
  private degradedReason: DegradedReason | null = null;
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

  getState(): ResourceGuardState {
    return { degraded: this.degraded, reason: this.degradedReason };
  }

  /** Piso de disco livre em bytes (env RESOURCE_GUARD_MIN_DISK_GB, default 5 GB). */
  static minFreeDiskBytes(): number {
    const gb = Number(process.env.RESOURCE_GUARD_MIN_DISK_GB);
    const effective = Number.isFinite(gb) && gb > 0 ? gb : ResourceGuardService.DEFAULT_MIN_DISK_GB;
    return effective * 1024 * 1024 * 1024;
  }

  /**
   * Exposto para testes: injeta uma amostra e reavalia o estado.
   * `freeDiskBytes = null` significa "não amostrado" e não degrada por disco.
   */
  evaluate(
    cpuUsage: number,
    freeMemBytes: number,
    now = Date.now(),
    freeDiskBytes: number | null = null,
  ): boolean {
    this.samples.push(cpuUsage);
    if (this.samples.length > ResourceGuardService.WINDOW) this.samples.shift();
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    const memLow = freeMemBytes < ResourceGuardService.minFreeMemBytes();
    const diskLow =
      freeDiskBytes !== null && freeDiskBytes < ResourceGuardService.minFreeDiskBytes();

    if (!this.degraded) {
      if (avg > ResourceGuardService.CPU_HIGH || memLow || diskLow) {
        this.degraded = true;
        this.degradedReason = avg > ResourceGuardService.CPU_HIGH ? 'cpu' : memLow ? 'ram' : 'disk';
        this.lowSince = null;
        this.logger.warn(
          `Modo degradado (${this.degradedReason}): cpu=${(avg * 100).toFixed(0)}% ` +
            `memLow=${memLow} diskLow=${diskLow}`,
        );
      }
    } else {
      const recovered = avg < ResourceGuardService.CPU_LOW && !memLow && !diskLow;
      if (recovered) {
        if (this.lowSince === null) this.lowSince = now;
        if (now - this.lowSince >= 30_000) {
          this.degraded = false;
          this.degradedReason = null;
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
    this.evaluate(this.readCpuUsage(), os.freemem(), Date.now(), this.readFreeDiskBytes());
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

  /** Espaço livre (statfs) do filesystem de UPLOAD_DEST; null se indisponível. */
  private readFreeDiskBytes(): number | null {
    try {
      const uploadsDir = path.resolve(process.env.UPLOAD_DEST || './uploads');
      const stats = fs.statfsSync(uploadsDir);
      return stats.bavail * stats.bsize;
    } catch {
      return null; // diretório inexistente/statfs indisponível: não degrada por disco
    }
  }
}
