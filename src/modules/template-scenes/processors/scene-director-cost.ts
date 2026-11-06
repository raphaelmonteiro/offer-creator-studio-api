import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { BriefChanges } from '../domain/scene-brief';
import { round6 } from '../domain/scene-timing';

/**
 * Custo do Diretor (G7): gravado fora de `metrics.calls` (que o disjuntor de chamadas pagas conta), em
 * `metrics.director`, e somado em `providerCostUsd` da versão e `totalCostUsd` da cena, em qualquer estado da
 * versão, inclusive `cancelled`. Custo desconhecido (resposta sem `usage`, tempo esgotado, erro) nunca soma
 * zero sem marca: `costUnknown`.
 */

export interface DirectorCallRecord {
  attempt: number;
  status: 'done' | 'failed';
  costUsd: number | null;
  requestId: string | null;
  latencyMs: number | null;
  /** Por que a chamada não serviu: `invalid`, `composition`, `timeout`, `error`, `quota`, `unpriced`. */
  problem?: string;
  /** O motivo dito ao Diretor na nova tentativa (auditoria): o que a validação não aceitou. */
  reason?: string;
}

export interface DirectorMetrics {
  calls: DirectorCallRecord[];
  costUsd: number;
  costUnknown: boolean;
  /** O que mudou na lista do que o cliente pediu neste turno. */
  brief?: BriefChanges;
}

/** Quanto custaram as chamadas: o que veio com `usage` soma, o resto marca `costUnknown`. */
export function summarizeDirectorCalls(calls: DirectorCallRecord[]): DirectorMetrics {
  const known = calls.filter((call) => call.costUsd !== null);
  return {
    calls,
    costUsd: round6(known.reduce((sum, call) => sum + (call.costUsd as number), 0)),
    // Modelo sem preço nunca foi chamado: não há custo a esconder.
    costUnknown: calls.some((call) => call.costUsd === null && call.problem !== 'unpriced'),
  };
}

/** Soma o custo na versão e na cena (muta as entidades; quem as grava é o chamador, sob o lock). */
export function addDirectorCost(
  target: { scene: TemplateScene; version: TemplateSceneVersion },
  director: DirectorMetrics,
): void {
  const { scene, version } = target;
  version.metrics = {
    ...version.metrics,
    director,
    ...(director.costUnknown ? { costUnknown: true } : {}),
  };
  version.providerCostUsd = round6(version.providerCostUsd + director.costUsd);
  scene.totalCostUsd = round6(scene.totalCostUsd + director.costUsd);
}
