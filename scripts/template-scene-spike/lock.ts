import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

export class LockError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Lock de processo no diretório de saída. Lock de processo morto: recusa e ensina a remover (sem remoção automática). */
export class RunLock {
  private readonly file: string;
  private held = false;

  constructor(dir: string) {
    this.file = path.join(dir, '.lock');
  }

  acquire(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const info: LockInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      host: os.hostname(),
    };
    try {
      fs.writeFileSync(this.file, JSON.stringify(info), { flag: 'wx' });
      this.held = true;
    } catch {
      throw new LockError(this.describeHolder());
    }
  }

  private describeHolder(): string {
    let other: LockInfo | null = null;
    try {
      other = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LockInfo;
    } catch {
      /* lock ilegível */
    }
    if (!other)
      return `Há um lock em ${this.file} que não pôde ser lido. Remova-o à mão se nenhuma execução estiver ativa.`;
    const state = pidAlive(other.pid)
      ? 'em andamento'
      : `de um processo que não existe mais; se nenhuma execução está ativa, remova ${this.file}`;
    return `Outra execução ${state}: PID ${other.pid}, iniciada em ${other.startedAt} (${other.host}).`;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* já removido */
    }
  }
}
