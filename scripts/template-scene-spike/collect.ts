import * as fs from 'fs';
import type { EditResult } from './edit-cases';
import { editJobs } from './edit-jobs';
import { Ledger } from './ledger';
import type { LedgerEntry } from './ledger';
import type { FallbackResult, PromoResult } from './promote';
import { StateStore } from './state';
import type { CasesFile } from './types';
import type { VisionResult } from './vision';

export interface Collected {
  /** Todos os resultados de edição concluídos (A, margem 8% e C). */
  edits: EditResult[];
  promos: PromoResult[];
  fallbacks: FallbackResult[];
  visions: VisionResult[];
  ledger: LedgerEntry[];
  /** Estado por chave (done, failed, skipped, pending) e o motivo. */
  status: Record<string, { status: string; reason?: string }>;
  spentUsd: number;
  /** Braços realmente medidos (markup recusado fica de fora). */
  mechanisms: string[];
}

/** Lê o estado, os resultados e o ledger de uma pasta de saída. Só leitura, sem rede. */
export function collect(dir: string, cases: CasesFile): Collected {
  const state = new StateStore(dir);
  const ledger = new Ledger(dir).entries();
  const jobs = editJobs(cases);
  const status: Collected['status'] = {};
  const take = <T>(key: string): T | null => {
    status[key] = { status: state.statusOf(key), reason: state.reasonOf(key) };
    return state.statusOf(key) === 'done' ? state.readResult<T>(key) : null;
  };
  const edits = [...jobs.a, ...jobs.c, ...jobs.margin]
    .map((j) => take<EditResult>(j.key))
    .filter(Boolean) as EditResult[];
  const promos = cases.promotions
    .map((p) => take<PromoResult>(`${p.id}:promo`))
    .filter(Boolean) as PromoResult[];
  const fallbacks = cases.promotions
    .map((p) => take<FallbackResult>(`${p.id}:fallback`))
    .filter(Boolean) as FallbackResult[];
  const visions = [...jobs.a, ...jobs.margin]
    .map((j) => take<VisionResult>(`E:${j.key}`))
    .filter(Boolean) as VisionResult[];
  const measured = new Set(edits.filter((e) => e.block === 'A').map((e) => e.mechanism));
  return {
    edits,
    promos,
    fallbacks,
    visions,
    ledger,
    status,
    spentUsd: ledger.reduce((s, e) => s + (e.costUsd || 0), 0),
    mechanisms: ['mask', 'markup'].filter((m) => measured.has(m as 'mask' | 'markup')),
  };
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}
