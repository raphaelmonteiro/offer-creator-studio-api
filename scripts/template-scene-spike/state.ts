import * as fs from 'fs';
import * as path from 'path';
import type { CaseState, CaseStatus } from './types';

interface StateFile {
  cases: Record<string, CaseState>;
}

const fileSafe = (id: string): string => id.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Estado por caso (`state.json`) e resultados por caso (`results/<id>.json`). */
export class StateStore {
  private data: StateFile = { cases: {} };
  readonly file: string;
  readonly resultsDir: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, 'state.json');
    this.resultsDir = path.join(dir, 'results');
    if (fs.existsSync(this.file))
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StateFile;
  }

  statusOf(id: string): CaseStatus {
    return this.data.cases[id]?.status ?? 'pending';
  }

  reasonOf(id: string): string | undefined {
    return this.data.cases[id]?.reason;
  }

  set(id: string, status: CaseStatus, reason?: string): void {
    this.data.cases[id] = { status, reason, updatedAt: new Date().toISOString() };
    this.save();
  }

  /** Grava o arquivo inteiro; chamado também na interrupção (Ctrl+C). */
  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  writeResult(id: string, result: unknown): void {
    fs.mkdirSync(this.resultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.resultsDir, `${fileSafe(id)}.json`),
      JSON.stringify(result, null, 2),
      'utf8',
    );
  }

  readResult<T>(id: string): T | null {
    const file = path.join(this.resultsDir, `${fileSafe(id)}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
  }

  hasResults(): boolean {
    return fs.existsSync(this.resultsDir) && fs.readdirSync(this.resultsDir).length > 0;
  }
}
