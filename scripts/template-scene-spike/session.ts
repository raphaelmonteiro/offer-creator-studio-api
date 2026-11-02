import * as fs from 'fs';
import * as path from 'path';
import { Budget } from './budget';
import type { BudgetOptions } from './budget';
import { Ledger } from './ledger';
import { RunLock } from './lock';
import { StateStore } from './state';
import type { CallContext } from './paid-call';

export interface Session {
  dir: string;
  runId: string;
  dryRun: boolean;
  ledger: Ledger;
  state: StateStore;
  lock: RunLock;
  budget: Budget;
  ctx: CallContext;
}

export class LedgerMissingError extends Error {}

/** Recusa rodar com resultados ou cenas em disco e sem ledger: o gasto anterior seria ignorado. */
export function assertLedgerConsistent(dir: string, ledger: Ledger, state: StateStore): void {
  const scenesDir = path.join(dir, 'scenes');
  const hasScenes = fs.existsSync(scenesDir) && fs.readdirSync(scenesDir).length > 0;
  if ((state.hasResults() || hasScenes) && !ledger.exists()) {
    throw new LedgerMissingError(
      `Há resultados ou cenas em ${dir} e não há ledger.jsonl: o gasto anterior seria ignorado e o teto perderia o sentido. ` +
        'Restaure o ledger ou apague a pasta inteira de propósito.',
    );
  }
}

/** Abre a sessão: confere o ledger, toma o lock e monta o disjuntor. O chamador solta o lock no fim. */
export function openSession(dir: string, dryRun: boolean, budget: BudgetOptions): Session {
  fs.mkdirSync(dir, { recursive: true });
  const ledger = new Ledger(dir);
  const state = new StateStore(dir);
  assertLedgerConsistent(dir, ledger, state);
  const lock = new RunLock(dir);
  lock.acquire();
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const guard = new Budget(ledger, budget);
  return {
    dir,
    runId,
    dryRun,
    ledger,
    state,
    lock,
    budget: guard,
    ctx: { budget: guard, ledger, runId, dryRun },
  };
}

/** Ctrl+C: grava o estado, solta o lock e sai. Devolve o handler para poder ser exercitado no `--dry-run`. */
export function installInterruptHandler(
  session: Session,
  exit: (code: number) => void = process.exit,
  register = true,
): () => void {
  const handler = (): void => {
    session.state.save();
    session.lock.release();
    process.stderr.write(
      '\nInterrompido: estado e ledger gravados, lock removido. A próxima execução retoma.\n',
    );
    exit(130);
  };
  if (register) process.once('SIGINT', handler);
  return handler;
}
