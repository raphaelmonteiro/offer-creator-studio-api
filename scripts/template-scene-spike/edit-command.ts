import * as fs from 'fs';
import * as path from 'path';
import type { Services } from './calls';
import { runEdit } from './edit-runner';
import type { EditOptions } from './edit-runner';
import { runGenerate } from './generate';
import { FakeRemover, RealRemover } from './remover';
import type { Remover } from './remover';
import { SceneStore } from './scene-store';
import type { CasesFile } from './types';

/** Remover do modo atual: falso no dry-run, Replicate com token, ou null (bloco B fica `skipped`). */
export function pickRemover(svc: Services): Remover | null {
  if (svc.session.dryRun) return new FakeRemover();
  return svc.config.replicateToken
    ? new RealRemover(svc.config.replicateToken, svc.session.dir)
    : null;
}

export async function editCommand(
  svc: Services,
  cases: CasesFile,
  opts: EditOptions,
  remover: Remover | null = pickRemover(svc),
): Promise<void> {
  const scenesDir = path.join(svc.session.dir, 'scenes');
  if (svc.session.dryRun && !fs.existsSync(scenesDir)) await runGenerate(svc, cases);
  await runEdit({ svc, cases, remover, scenes: new SceneStore(svc.session.dir, cases), opts });
}
