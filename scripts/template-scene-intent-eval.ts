/**
 * Avaliação paga do reconhecimento de intenção (task 1.45, D-19). Roda no host, fora do Nest e fora da
 * suíte, com o modelo real e SÓ texto (nenhuma chamada de imagem). Mesmo caminho da produção:
 * `OpenAiIntentService` -> `SceneIntentService` (prompt, schema, validação, custo).
 *
 *   PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH" node -r ts-node/register -r tsconfig-paths/register \
 *     scripts/template-scene-intent-eval.ts --pass pass1 --out <pasta> [--ids a,b] [--cap 0.06] [--dry]
 *
 * A chave é lida de `backend/.env` em tempo de execução, só na memória: nunca é impressa, gravada nem
 * passada por argumento. Teto cumulativo em `<out>/state.json`; antes de CADA chamada soma o gasto ao pior
 * caso da chamada e, se passar do teto, para sem fazê-la.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { OpenAiIntentService } from '../src/modules/ai/openai-intent.service';
import { SceneIntent } from '../src/modules/template-scenes/domain/scene-intent';
import { planFromIntent } from '../src/modules/template-scenes/domain/scene-intent-plan';
import {
  buildIntentSystemPrompt,
  buildIntentUserPrompt,
} from '../src/modules/template-scenes/domain/scene-intent-prompt';
import { LocalTarget } from '../src/modules/template-scenes/domain/scene-operation.classifier';
import { SceneElement } from '../src/modules/template-scenes/domain/scene.types';
import { MockSceneIntentClient } from '../src/modules/template-scenes/providers/mock-scene-intent.client';
import { SceneIntentService } from '../src/modules/template-scenes/services/scene-intent.service';

interface EvalCase {
  id: string;
  group: string;
  message: string;
  marked: boolean;
  expect: SceneIntent;
  accept?: Array<{ action: string; zone: string | null }>;
}

interface Row {
  id: string;
  group: string;
  message: string;
  marked: boolean;
  expect: SceneIntent;
  accept: Array<{ action: string; zone: string | null }>;
  status: string;
  got: SceneIntent | null;
  costUsd: number | null;
  latencyMs: number;
  requestId: string | null;
  expectedOp: string;
  gotOp: string | null;
  actionZoneOk: boolean;
  outcomeOk: boolean;
  costly: boolean;
}

const ROOT = path.resolve(__dirname, '..');
const EVAL = path.join(ROOT, 'src/modules/template-scenes/domain/scene-intent.eval.json');
const ENV_FILE = path.resolve(ROOT, '../../../backend/.env');
const RECT: LocalTarget = { kind: 'rect', rect: { x: 0.3, y: 0.4, w: 0.3, h: 0.2 } };
/** Contexto único para todas as frases, como numa cena com logo, texto e uma camada adicionada. */
const LAYERS = [
  { name: 'Logo 1', kind: 'logo' },
  { name: 'Texto 1', kind: 'text' },
  { name: 'Cesta de ovos', kind: 'generated' },
];
const PLAN_LAYERS = [
  { id: 'cesta-1', kind: 'generated', name: 'Cesta de ovos' },
] as unknown as SceneElement[];
const QUESTION_OPS = new Set([
  'needs_region',
  'needs_confirmation_global',
  'needs_confirmation_new_image',
  'move_unavailable',
  'set_layer',
]);
/** Custo contado (conservador) quando o provedor não devolve `usage`: tempo esgotado ou erro podem ter sido cobrados. */
const UNKNOWN_COST_USD = 0.0004;
const DIRECT_OPS = new Set(['local_edit', 'add_element']);

function readKey(): string {
  const text = fs.readFileSync(ENV_FILE, 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('OPENAI_API_KEY='));
  const value = (line ?? '')
    .slice('OPENAI_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!value) throw new Error('OPENAI_API_KEY ausente em backend/.env');
  return value;
}

const redact = (text: string): string => text.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
}

function opOf(intent: SceneIntent, marked: boolean): string {
  return planFromIntent(intent, {
    content: 'x',
    marked: marked ? RECT : null,
    layers: PLAN_LAYERS,
  }).operation;
}

function score(
  c: EvalCase,
  got: SceneIntent | null,
): Pick<Row, 'actionZoneOk' | 'outcomeOk' | 'gotOp' | 'costly' | 'expectedOp'> {
  const expectedOp = opOf(c.expect, c.marked);
  if (!got)
    return { actionZoneOk: false, outcomeOk: false, gotOp: null, costly: false, expectedOp };
  const accepted = [{ action: c.expect.action, zone: c.expect.zone }, ...(c.accept ?? [])];
  const actionZoneOk = accepted.some(
    (a) => a.action === got.action && (a.zone ?? null) === (got.zone ?? null),
  );
  const gotOp = opOf(got, c.marked);
  const okOps = new Set([
    expectedOp,
    ...(c.accept ?? []).map((a) => opOf({ ...c.expect, ...a } as SceneIntent, c.marked)),
  ]);
  return {
    actionZoneOk,
    outcomeOk: okOps.has(gotOp),
    gotOp,
    costly: QUESTION_OPS.has(expectedOp) && DIRECT_OPS.has(gotOp),
    expectedOp,
  };
}

async function main(): Promise<void> {
  Logger.overrideLogger(false);
  const out = arg('out');
  if (!out) throw new Error('--out obrigatório');
  fs.mkdirSync(out, { recursive: true });
  const pass = arg('pass', 'pass1') as string;
  const cap = Number(arg('cap', '0.06'));
  const stateFile = path.join(out, 'state.json');
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    : { spentUsd: 0, calls: 0 };
  const ids = arg('ids')?.split(',');
  const all: EvalCase[] = JSON.parse(fs.readFileSync(EVAL, 'utf8'));
  const cases = ids ? all.filter((c) => ids.includes(c.id)) : all;
  // `--dry`: o `mock` no lugar do modelo (confere a fiação, sem chave e sem custo)
  const dry = process.argv.includes('--dry');
  const config = new ConfigService(dry ? {} : { OPENAI_API_KEY: readKey() });
  const service = new SceneIntentService(
    config,
    dry ? new MockSceneIntentClient() : new OpenAiIntentService(config),
  );
  const file = path.join(out, `${pass}.jsonl`);
  const done = new Set(
    fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l).id)
      : [],
  );
  const notRun: string[] = [];
  let stopped = false;
  for (const c of cases) {
    if (done.has(c.id)) continue;
    const system = buildIntentSystemPrompt({ marked: c.marked, layers: LAYERS });
    const user = buildIntentUserPrompt(c.message);
    // pior caso: entrada a 2,5 caracteres por token mais o teto de 1000 tokens de saída
    const worst = ((system.length + user.length) / 2.5) * 0.1e-6 + 1000 * 0.5e-6;
    if (stopped || state.spentUsd + worst > cap) {
      stopped = true;
      notRun.push(c.id);
      continue;
    }
    const outcome = await service.classify({
      message: c.message,
      context: { marked: c.marked, layers: LAYERS },
      correlationId: `eval-${c.id}`,
    });
    const got = outcome.status === 'ok' ? outcome.intent : null;
    const charged = outcome.metrics.costUsd ?? UNKNOWN_COST_USD;
    state.spentUsd = Math.round((state.spentUsd + charged) * 1e8) / 1e8;
    if (outcome.metrics.costUsd === null)
      state.unknownCostCalls = (state.unknownCostCalls ?? 0) + 1;
    state.calls += 1;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const row: Row = {
      id: c.id,
      group: c.group,
      message: c.message,
      marked: c.marked,
      expect: c.expect,
      accept: c.accept ?? [],
      status: outcome.status,
      got,
      costUsd: outcome.metrics.costUsd,
      latencyMs: outcome.metrics.latencyMs,
      requestId: outcome.metrics.requestId,
      ...score(c, got),
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    process.stdout.write(
      `${c.id} ${outcome.status} ${row.actionZoneOk ? 'ok' : 'ERRO'} ${redact(String(row.costUsd))}\n`,
    );
  }
  fs.writeFileSync(path.join(out, `${pass}.notrun.json`), JSON.stringify(notRun, null, 2));
  process.stdout.write(
    `gasto acumulado US$ ${state.spentUsd} em ${state.calls} chamadas; sem rodar: ${notRun.length}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`falhou: ${redact((error as Error).message)}\n`);
  process.exit(1);
});
