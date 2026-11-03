import * as fs from 'fs';
import * as path from 'path';
import { StopError } from './budget';
import { assertPriced } from './calls';
import type { Services } from './calls';
import { createClient } from './client-factory';
import { loadConfig, loadPrices, OUT_ROOT, replicatePrice } from './config';
import { loadCases, validateCases } from './plan';
import { writeReport } from './report';
import { installInterruptHandler, openSession } from './session';
import type { CasesFile } from './types';

export interface CliOptions {
  confirmSpend: boolean;
  only?: string;
  block?: string;
  fresh: boolean;
}

export const DRY_RUN_DIR = path.join(OUT_ROOT, '_dryrun');

/** Execução real grava em `out/template-scene-spike/`; a simulação, numa pasta própria dentro dela. */
export function resolveOutDir(confirmSpend: boolean): string {
  return confirmSpend ? OUT_ROOT : DRY_RUN_DIR;
}

export function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Abre a sessão (preços, casos, chave, ledger, lock, Ctrl+C), roda o comando e, numa parada (P1 a P5),
 * grava o estado e informa. O lock é sempre solto ao sair.
 */
export async function withSession(
  opts: CliOptions,
  fn: (svc: Services, cases: CasesFile) => Promise<void>,
): Promise<void> {
  const config = loadConfig();
  const prices = loadPrices();
  assertPriced(config, prices);
  const cases = loadCases();
  const validation = validateCases(cases);
  if (validation.errors.length)
    throw new Error(`Plano inválido:\n  - ${validation.errors.join('\n  - ')}`);
  const client = createClient(config, opts.confirmSpend);
  const dryRun = !opts.confirmSpend;
  const dir = resolveOutDir(opts.confirmSpend);
  if (dryRun && opts.fresh) fs.rmSync(dir, { recursive: true, force: true });
  const session = openSession(dir, dryRun, {
    budgetUsd: config.budgetUsd,
    initialReserveUsd: config.initialReserveUsd,
    maxCallUsd: config.maxCallUsd,
    fixedReserves: { remove_bg: replicatePrice(prices).perRunUsd },
  });
  installInterruptHandler(session);
  say(
    dryRun
      ? 'SIMULAÇÃO (--dry-run): nenhuma chamada paga será feita. Use --confirm-spend para gastar.'
      : 'EXECUÇÃO REAL: chamadas pagas autorizadas por --confirm-spend.',
  );
  say(`Saída: ${dir}`);
  try {
    await fn({ config, prices, client, session }, cases);
  } catch (err) {
    session.state.save();
    if (!(err instanceof StopError)) throw err;
    say(`\nParada (${err.code}): ${err.message}`);
    say(
      `Gasto acumulado US$ ${session.budget.spentUsd().toFixed(4)} de US$ ${config.budgetUsd.toFixed(2)}. Estado gravado; a próxima execução retoma.`,
    );
    try {
      say(`Relatório parcial: ${writeReport(dir, cases, config, prices, dryRun)}`);
    } catch (reportErr) {
      say(`Relatório parcial não gerado: ${(reportErr as Error).message}`);
    }
    process.exitCode = 1;
  } finally {
    session.lock.release();
  }
  say(
    `Gasto acumulado: US$ ${session.budget.spentUsd().toFixed(4)} (teto US$ ${config.budgetUsd.toFixed(2)})`,
  );
}
