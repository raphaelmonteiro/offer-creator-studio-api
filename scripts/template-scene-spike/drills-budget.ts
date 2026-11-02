import * as fs from 'fs';
import * as path from 'path';
import { loadPrices, imagePrice } from './config';
import { Drill, drillDir } from './drill-util';
import type { LedgerEntry } from './ledger';
import { LockError } from './lock';
import { runPaidCall } from './paid-call';
import { installInterruptHandler, LedgerMissingError, openSession } from './session';

const BUDGET = { budgetUsd: 100, initialReserveUsd: 2, maxCallUsd: 3 };

function seed(costUsd: number, kind: LedgerEntry['kind'] = 'edit'): LedgerEntry {
  return {
    ts: new Date().toISOString(),
    runId: 'seed',
    caseId: 'seed',
    block: 'A',
    step: 'seed',
    kind,
    provider: 'openai',
    endpoint: 'images.edits',
    model: 'm',
    costUsd,
    costEstimated: false,
    latencyMs: 1,
    status: 'ok',
  };
}

async function budgetCeiling(d: Drill): Promise<void> {
  d.section('Orçamento e disjuntor: teto atingido e teto entre execuções');
  const dir = drillDir('teto');
  const first = openSession(dir, false, BUDGET);
  first.ledger.append(seed(60));
  first.lock.release();
  const second = openSession(dir, false, BUDGET);
  d.check('teto vale entre execuções (gasto de 60 lido do disco)', second.budget.spentUsd() === 60);
  second.ledger.append(seed(38.5));
  await d.rejects(
    '98,50 + reserva 2 > 100: não chama',
    () => second.budget.guard('edit'),
    /Orçamento atingido.*98\.50.*100\.00/,
  );
  second.lock.release();
  second.ledger.append(seed(0.5, 'generate'));
  const third = openSession(dir, false, BUDGET);
  d.check(
    'reserva = 1,5x o maior custo observado do tipo',
    third.budget.reserveFor('edit') === 60 * 1.5,
  );
  d.check('sem observação usa a reserva inicial', third.budget.reserveFor('vision') === 2);
  third.lock.release();
}

async function missingPrice(d: Drill): Promise<void> {
  d.section('Preço ausente');
  const dir = drillDir('preco');
  const file = path.join(dir, 'prices.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: { other: { sources: ['x'], consultedAt: '2026-11-02' } } }),
  );
  await d.rejects(
    'entrada ausente: recusa e diz qual',
    () => imagePrice(loadPrices(file), 'gpt-image-2.5-sunburst', 'high'),
    /gpt-image-2\.5-sunburst/,
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      entries: { m: { perMillionTokens: { imageInput: 1, textInput: 1, imageOutput: 1 } } },
    }),
  );
  await d.rejects(
    'entrada sem fonte e data: recusa',
    () => imagePrice(loadPrices(file), 'm', 'high'),
    /sem fonte/,
  );
}

async function usageMissing(d: Drill): Promise<void> {
  d.section('Resposta sem usage e dry-run');
  const session = openSession(drillDir('usage'), true, BUDGET);
  const spec = {
    kind: 'generate' as const,
    caseId: 'C1',
    block: 'F',
    step: 'generate',
    provider: 'openai' as const,
    endpoint: 'images.generate',
    model: 'm',
  };
  await runPaidCall(session.ctx, spec, async () => ({ value: 1, costUsd: null }));
  const [line] = session.ledger.entries();
  d.check('sem usage: custo = reserva e costEstimated', line.costUsd === 2 && line.costEstimated);
  d.check(
    'dry-run grava só status dry_run',
    session.ledger.entries().every((e) => e.status === 'dry_run'),
  );
  session.lock.release();
}

async function ledgerMissing(d: Drill): Promise<void> {
  d.section('Ledger apagado com resultados existentes');
  const dir = drillDir('ledger');
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'results', 'A01.json'), '{}');
  await d.rejects(
    'recusa rodar',
    () => openSession(dir, false, BUDGET),
    (e) => e instanceof LedgerMissingError && /gasto anterior/.test(e.message),
  );
}

async function lockAndResume(d: Drill): Promise<void> {
  d.section('Retomada, concorrência e interrupção manual');
  const dir = drillDir('lock');
  const first = openSession(dir, true, BUDGET);
  await d.rejects(
    'segunda execução recusada pelo lock, com PID e hora',
    () => openSession(dir, true, BUDGET),
    (e) =>
      e instanceof LockError &&
      e.message.includes(`PID ${process.pid}`) &&
      /iniciada em \d{4}-/.test(e.message),
  );
  first.state.set('A01', 'done');
  first.state.set('A02', 'failed', 'x');
  let exited = -1;
  const handler = installInterruptHandler(
    first,
    (c) => {
      exited = c;
    },
    false,
  );
  handler();
  d.check(
    'Ctrl+C grava o estado e remove o lock',
    exited === 130 &&
      fs.existsSync(path.join(dir, 'state.json')) &&
      !fs.existsSync(path.join(dir, '.lock')),
  );
  const again = openSession(dir, true, BUDGET);
  d.check(
    'nova execução vê A01 done e A03 pending',
    again.state.statusOf('A01') === 'done' && again.state.statusOf('A03') === 'pending',
  );
  again.lock.release();
}

export async function runBudgetDrills(d: Drill): Promise<void> {
  await budgetCeiling(d);
  await missingPrice(d);
  await usageMissing(d);
  await ledgerMissing(d);
  await lockAndResume(d);
}
