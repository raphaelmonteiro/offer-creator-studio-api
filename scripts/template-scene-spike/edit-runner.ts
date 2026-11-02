import { StopError } from './budget';
import type { Services } from './calls';
import { runEditJob } from './edit-cases';
import type { EditResult } from './edit-cases';
import { editJobs } from './edit-jobs';
import type { EditJob } from './edit-jobs';
import { runFallback, runPromotion } from './promote';
import type { PromoResult } from './promote';
import type { Remover } from './remover';
import { RecomposeMismatchError } from './recompose';
import { say } from './runner';
import { SceneStore } from './scene-store';
import type { CasesFile, PromotionCase } from './types';
import { runVisionFor } from './vision';

export interface EditOptions {
  only?: string;
  block?: string;
}

export interface EditDeps {
  svc: Services;
  cases: CasesFile;
  /** null = sem token do Replicate: o bloco B fica `skipped`. */
  remover: Remover | null;
  scenes: SceneStore;
  opts: EditOptions;
}

export const matchesOnly = (key: string, only?: string): boolean =>
  !only || key === only || key.startsWith(`${only}:`);

/** Chaves de estado de todo o plano (para saber se o plano terminou). */
export function allPlanKeys(cases: CasesFile): string[] {
  const jobs = editJobs(cases);
  const edits = [...jobs.a, ...jobs.c, ...jobs.margin].map((j) => j.key);
  const promos = cases.promotions.flatMap((p) => [`${p.id}:promo`, `${p.id}:fallback`]);
  const visions = [...jobs.a, ...jobs.margin].map((j) => `E:${j.key}`);
  return [...edits, ...promos, ...visions];
}

async function guarded(deps: EditDeps, key: string, fn: () => Promise<unknown>): Promise<void> {
  const { state } = deps.svc.session;
  try {
    const result = await fn();
    state.writeResult(key, result);
    state.set(key, 'done');
    say(`  ${key} ok`);
  } catch (err) {
    if (err instanceof StopError) throw err;
    const reason =
      err instanceof RecomposeMismatchError ? err.code : (err as Error).message.slice(0, 200);
    state.set(key, 'failed', reason);
    say(`  ${key} falhou: ${reason}`);
  }
}

function shouldRun(deps: EditDeps, key: string): boolean {
  const { only } = deps.opts;
  if (!matchesOnly(key, only)) return false;
  const status = deps.svc.session.state.statusOf(key);
  if (only && matchesOnly(key, only)) return true;
  return status === 'pending' || status === 'failed';
}

async function runJobs(deps: EditDeps, jobs: EditJob[]): Promise<void> {
  const { session } = deps.svc;
  for (const job of jobs) {
    if (!shouldRun(deps, job.key)) continue;
    if (job.arm === 'markup' && session.budget.isMarkupDisabled()) {
      session.state.set(job.key, 'skipped', 'markup recusado pela API (P3): braço desligado');
      continue;
    }
    const scene = await deps.scenes.get(job.edit.sceneId);
    await guarded(deps, job.key, () => runEditJob(deps.svc, scene, job));
  }
}

/** P6: os 3 primeiros destacáveis com recorte vazio encerram as etapas pagas da promoção. */
export function earlyAbandon(deps: EditDeps): boolean {
  const destacaveis = deps.cases.promotions.filter((p) => !p.atmospheric).slice(0, 3);
  if (destacaveis.length < 3) return false;
  return destacaveis.every(
    (p) => deps.svc.session.state.readResult<PromoResult>(`${p.id}:promo`)?.cutout === 'vazio',
  );
}

async function runPromoBlock(deps: EditDeps): Promise<void> {
  const { state } = deps.svc.session;
  const { promotions } = deps.cases;
  const promo = async (p: PromotionCase): Promise<void> => {
    const key = `${p.id}:promo`;
    if (!shouldRun(deps, key)) return;
    if (!deps.remover) return void state.set(key, 'skipped', 'REPLICATE_API_TOKEN ausente');
    if (!deps.opts.only && !p.atmospheric && earlyAbandon(deps)) {
      return void state.set(key, 'skipped', 'abandono antecipado (P6)');
    }
    const scene = await deps.scenes.get(p.sceneId);
    await guarded(deps, key, () => runPromotion(deps.svc, deps.remover!, scene, p));
  };
  for (const p of promotions) await promo(p);
  for (const p of promotions) {
    const key = `${p.id}:fallback`;
    if (!shouldRun(deps, key)) continue;
    const scene = await deps.scenes.get(p.sceneId);
    await guarded(deps, key, () => runFallback(deps.svc, scene, p));
  }
}

async function runVisionBlock(deps: EditDeps): Promise<void> {
  const jobs = editJobs(deps.cases);
  const { state } = deps.svc.session;
  for (const job of [...jobs.a, ...jobs.margin]) {
    const key = `E:${job.key}`;
    const edit = state.readResult<EditResult>(job.key);
    if (!shouldRun(deps, key) || !edit || state.statusOf(job.key) !== 'done') continue;
    await guarded(deps, key, () => runVisionFor(deps.svc, edit));
  }
}

/** Fase 2: blocos na ordem do design (A mask, A markup, C, B, margem, E); o plano concluído não gasta. */
export async function runEdit(deps: EditDeps): Promise<void> {
  const { state } = deps.svc.session;
  const { only, block } = deps.opts;
  const keys = allPlanKeys(deps.cases);
  if (!only && keys.every((k) => ['done', 'skipped'].includes(state.statusOf(k)))) {
    say('Plano concluído: todos os casos estão done ou skipped. Nenhuma chamada paga foi feita.');
    return;
  }
  const jobs = editJobs(deps.cases);
  const wants = (b: string): boolean => !block || block === b;
  if (wants('A')) await runJobs(deps, jobs.a);
  if (wants('C')) await runJobs(deps, jobs.c);
  if (wants('B')) await runPromoBlock(deps);
  if (wants('A')) await runJobs(deps, jobs.margin);
  if (wants('E')) await runVisionBlock(deps);
  const left = keys.filter((k) => !['done', 'skipped'].includes(state.statusOf(k)));
  say(
    `Fase 2: ${keys.length - left.length} de ${keys.length} casos done ou skipped; ${left.length} pendentes ou com falha.`,
  );
}
