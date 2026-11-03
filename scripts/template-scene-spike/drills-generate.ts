import * as sharp from 'sharp';
import type { Services } from './calls';
import { loadConfig, loadPrices } from './config';
import { Drill, drillDir } from './drill-util';
import { FakeOpenAi } from './fake-openai';
import { buildScenePrompt, runGenerate } from './generate';
import { FORMATS } from './formats';
import { loadCases, validateCases } from './plan';
import { openSession } from './session';

const BUDGET = { budgetUsd: 100, initialReserveUsd: 2, maxCallUsd: 3 };

export async function runGenerateDrills(d: Drill): Promise<void> {
  d.section('Fase 1 (generate) em dry-run: 5 cenas sintéticas nos tamanhos do plan');
  const cases = loadCases();
  const sizes = validateCases(cases).sizes;
  const session = openSession(drillDir('generate'), true, BUDGET);
  const svc: Services = {
    config: loadConfig({} as NodeJS.ProcessEnv),
    prices: loadPrices(),
    client: new FakeOpenAi(),
    session,
  };
  await runGenerate(svc, cases);
  for (const scene of cases.scenes) {
    const meta = await sharp(`${session.dir}/scenes/${scene.id}.png`).metadata();
    const want = sizes[scene.id];
    d.check(
      `${scene.id}: arquivo ${want.width}x${want.height}`,
      meta.width === want.width && meta.height === want.height,
      `${meta.width}x${meta.height}`,
    );
  }
  const lines = session.ledger.entries();
  d.check(
    'ledger com 5 linhas, todas dry_run, com custo a partir do usage',
    lines.length === 5 &&
      lines.every((l) => l.status === 'dry_run' && !l.costEstimated && l.costUsd > 0),
  );
  await runGenerate(svc, cases);
  d.check(
    'segunda execução pula as concluídas (sem novas linhas)',
    session.ledger.entries().length === 5,
  );
  await runGenerate(svc, cases, 'C3');
  d.check(
    '--only C3 refaz uma cena de propósito (6 linhas)',
    session.ledger.entries().length === 6,
  );
  const prompt = buildScenePrompt(cases.scenes[0], FORMATS['folheto-27x54']);
  d.check(
    'prompt em português com as regras fixas e as zonas do formato',
    /Sem texto legível, sem logotipos, sem preços/.test(prompt) &&
      /cabeçalho/.test(prompt) &&
      /11%/.test(prompt) &&
      /7%/.test(prompt),
  );
  session.lock.release();
}
