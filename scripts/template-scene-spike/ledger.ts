import * as fs from 'fs';
import * as path from 'path';
import type { CallKind } from './types';

export type LedgerStatus = 'ok' | 'error' | 'dry_run';

export interface LedgerEntry {
  ts: string;
  runId: string;
  caseId: string;
  block: string;
  step: string;
  kind: CallKind;
  provider: 'openai' | 'replicate';
  endpoint: string;
  model: string;
  size?: string;
  quality?: string;
  requestId?: string | null;
  usage?: unknown;
  costUsd: number;
  costEstimated: boolean;
  latencyMs: number;
  status: LedgerStatus;
  errorCode?: string;
}

/** Ledger JSONL só por acréscimo: a fonte do gasto acumulado (nunca uma variável em memória). */
export class Ledger {
  readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, 'ledger.jsonl');
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  append(entry: LedgerEntry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  entries(): LedgerEntry[] {
    if (!this.exists()) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  /** Soma de `costUsd` de todas as linhas em disco, de todas as execuções. */
  spentUsd(): number {
    return this.entries().reduce((sum, e) => sum + (e.costUsd || 0), 0);
  }

  /** Maior custo observado para um tipo de chamada, ou null se não houver observação. */
  maxCostOf(kind: CallKind): number | null {
    const costs = this.entries()
      .filter((e) => e.kind === kind && e.status !== 'error' && e.costUsd > 0)
      .map((e) => e.costUsd);
    return costs.length ? Math.max(...costs) : null;
  }
}
