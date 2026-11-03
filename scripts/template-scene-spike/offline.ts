import * as fs from 'fs';
import type { Services } from './calls';
import { loadConfig, loadPrices, OUT_ROOT } from './config';
import { runEditJob } from './edit-cases';
import type { EditResult } from './edit-cases';
import { editJobs } from './edit-jobs';
import { runFallback } from './promote';
import type { FallbackResult, StepSummary } from './promote';
import { loadCases } from './plan';
import { say } from './runner';
import { SceneStore } from './scene-store';
import { openSession } from './session';
import type { SpikeOpenAi } from './openai-client';
import type { CasesFile } from './types';

/** Regra do spike (PV-21): mudança de recomposição nunca chama o modelo; este cliente falha se for chamado. */
const NO_CALLS: SpikeOpenAi = {
  generate: () => Promise.reject(new Error('recompose é offline: nenhuma chamada paga')),
  edit: () => Promise.reject(new Error('recompose é offline: nenhuma chamada paga')),
  vision: () => Promise.reject(new Error('recompose é offline: nenhuma chamada paga')),
};

const offlineOf = (step: StepSummary, providerMs: number) => ({
  png: fs.readFileSync(step.files.raw),
  costUsd: step.costUsd,
  requestId: step.requestId,
  providerMs,
});

/**
 * Recompõe offline, a partir das saídas brutas salvas, os resultados de edição (A, C, margem) e os
 * fallbacks, com o recuo vigente (PV-17). Não toca no ledger nem na rede.
 */
export async function runRecompose(
  only?: string,
  dir: string = OUT_ROOT,
  cases: CasesFile = loadCases(),
): Promise<number> {
  const session = openSession(dir, false, {
    budgetUsd: 0.01,
    initialReserveUsd: 0.01,
    maxCallUsd: 0.01,
  });
  try {
    const svc: Services = { config: loadConfig(), prices: loadPrices(), client: NO_CALLS, session };
    const scenes = new SceneStore(dir, cases);
    const before = session.ledger.entries().length;
    const jobs = editJobs(cases);
    let n = 0;
    for (const job of [...jobs.a, ...jobs.c, ...jobs.margin]) {
      const old =
        session.state.statusOf(job.key) === 'done'
          ? session.state.readResult<EditResult>(job.key)
          : null;
      if (!old || (only && job.key !== only)) continue;
      const scene = await scenes.get(job.edit.sceneId);
      const next = await runEditJob(
        svc,
        scene,
        job,
        offlineOf(
          { ...(old as unknown as StepSummary), files: old.files },
          old.latencyMs.provider ?? 0,
        ),
      );
      session.state.writeResult(job.key, {
        ...next,
        requestId: old.requestId,
        costUsd: old.costUsd,
        latencyMs: next.latencyMs,
      });
      n += 1;
    }
    for (const promo of cases.promotions) {
      const key = `${promo.id}:fallback`;
      const old =
        session.state.statusOf(key) === 'done'
          ? session.state.readResult<FallbackResult>(key)
          : null;
      if (!old || (only && key !== only)) continue;
      const scene = await scenes.get(promo.sceneId);
      const next = await runFallback(svc, scene, promo, {
        source: offlineOf(old.source, old.source.latencyMs.provider ?? 0),
        destination: offlineOf(old.destination, old.destination.latencyMs.provider ?? 0),
      });
      session.state.writeResult(key, next);
      n += 1;
    }
    const after = session.ledger.entries().length;
    say(
      `Recomposição offline: ${n} resultados; linhas novas no ledger: ${after - before}; gasto US$ ${session.budget.spentUsd().toFixed(4)}`,
    );
    return n;
  } finally {
    session.lock.release();
  }
}
