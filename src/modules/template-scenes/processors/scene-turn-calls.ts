import { EntityManager } from 'typeorm';
import { SceneCallRecord } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

export interface CallOutcome {
  status: 'done' | 'failed';
  costUsd: number | null;
  requestId?: string | null;
  errorCode?: string;
  latencyMs?: number;
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/** Grava a tentativa na versão, ou devolve `'limit'` (sem gravar) quando o disjuntor de chamadas dispara. */
export async function recordCallIn(
  manager: EntityManager,
  version: TemplateSceneVersion,
  call: SceneCallRecord,
  maxCalls: number,
): Promise<'ok' | 'limit'> {
  const calls = version.metrics.calls ?? [];
  if (calls.length >= maxCalls) return 'limit';
  version.metrics = { ...version.metrics, calls: [...calls, call] };
  await manager.save(version);
  return 'ok';
}

/** Fecha a tentativa com o custo real e soma na versão e na cena. */
export async function closeCallIn(
  manager: EntityManager,
  target: { scene: TemplateScene; version: TemplateSceneVersion },
  callId: string,
  outcome: CallOutcome,
): Promise<void> {
  const { scene, version } = target;
  const cost = outcome.costUsd ?? 0;
  // G7: resposta paga sem custo conhecido nunca soma zero sem marca.
  const costUnknown = outcome.status === 'done' && outcome.costUsd === null;
  version.metrics = {
    ...version.metrics,
    ...(costUnknown ? { costUnknown: true } : {}),
    calls: (version.metrics.calls ?? []).map((call) =>
      call.id === callId
        ? {
            ...call,
            status: outcome.status,
            finishedAt: new Date().toISOString(),
            costUsd: outcome.costUsd,
            requestId: outcome.requestId ?? null,
            ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          }
        : call,
    ),
  };
  version.providerCostUsd = round6(version.providerCostUsd + cost);
  if (outcome.latencyMs !== undefined) version.latencyMs = outcome.latencyMs;
  scene.totalCostUsd = round6(scene.totalCostUsd + cost);
  await manager.save(version);
  await manager.save(scene);
}
