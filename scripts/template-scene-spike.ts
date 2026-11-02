/**
 * Spike do estágio 0 do Template Pro (change add-template-scene-spike). Roda no host, fora do Nest:
 * PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH" node -r ts-node/register -r tsconfig-paths/register \
 *   scripts/template-scene-spike.ts <comando> [--confirm-spend] [--only <id>] [--block A|B|C|E]
 */
import { StopError } from './template-scene-spike/budget';
import { Drill } from './template-scene-spike/drill-util';
import { runBudgetDrills } from './template-scene-spike/drills-budget';
import { runClientDrills } from './template-scene-spike/drills-client';
import { runPlanDrills } from './template-scene-spike/drills-plan';
import { loadConfig } from './template-scene-spike/config';
import { runPlan } from './template-scene-spike/plan';

interface Args {
  command: string;
  flags: Set<string>;
  values: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const [command = '', ...rest] = argv;
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    if (name === 'only' || name === 'block' || name === 'topic') values[name] = rest[(i += 1)];
    else flags.add(name);
  }
  return { command, flags, values };
}

async function selftest(topic: string | undefined): Promise<void> {
  const drill = new Drill();
  const all = !topic;
  if (all || topic === 'budget') await runBudgetDrills(drill);
  if (all || topic === 'client') await runClientDrills(drill);
  if (all || topic === 'plan') runPlanDrills(drill);
  process.stdout.write(`\n${drill.total - drill.failures}/${drill.total} verificações ok\n`);
  if (drill.failures > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'plan':
      return runPlan(loadConfig(), args.flags.has('strict'));
    case 'selftest':
      return selftest(args.values.topic);
    default:
      throw new Error(
        `Comando desconhecido: "${args.command}". Use plan, generate, edit, report, fixtures ou selftest.`,
      );
  }
}

main().catch((err: unknown) => {
  if (err instanceof StopError) {
    process.stderr.write(`\nParada (${err.code}): ${err.message}\n`);
  } else {
    process.stderr.write(`\nErro: ${(err as Error).message}\n`);
  }
  process.exitCode = 1;
});
