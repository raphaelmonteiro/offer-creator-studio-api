import { EntityManager } from 'typeorm';
import { CommercialsService } from '../commercials.service';
import { McKitProviderCost } from '../domain/mc-kit-costs';
import { McCharacterKit } from '../entities/mc-character-kit.entity';

/** Evento de custo do kit em `mc_events` (uma linha por chamada paga, `refKind = 'kit'`). */
export const MC_KIT_COST_EVENT = 'provider_cost';

/**
 * Registra o custo de UMA chamada paga do fluxo do kit (tarefa 2.6), na
 * transação de quem chama: evento `provider_cost` com a linha de custo (e o
 * contexto da chamada: asset, slot, rodada…) e incremento atômico de
 * `mc_character_kits.providerCostUsd` — a soma consultável do kit. Custo
 * desconhecido (`costUsd` null: modelo fora da tabela) fica só no evento.
 * `addToKit: false` = a soma já foi gravada por quem chama (INSERT do kit
 * com o custo do gate de boca do logo, que é pago antes de o kit existir).
 * O custo aconteceu mesmo quando a chamada não vira asset (resposta ilegível,
 * CAS perdido): por isso quem chama registra logo depois da resposta.
 */
export async function recordKitProviderCost(
  manager: EntityManager,
  commercials: Pick<CommercialsService, 'appendEvent'>,
  kit: Pick<McCharacterKit, 'id' | 'userId'>,
  cost: McKitProviderCost,
  context: Record<string, unknown> = {},
  options: { addToKit?: boolean } = {},
): Promise<void> {
  await commercials.appendEvent(manager, {
    userId: kit.userId,
    refKind: 'kit',
    refId: kit.id,
    kind: MC_KIT_COST_EVENT,
    detail: { ...context, ...cost },
  });
  if (options.addToKit !== false && cost.costUsd != null && cost.costUsd > 0) {
    await manager.increment(McCharacterKit, { id: kit.id }, 'providerCostUsd', cost.costUsd);
  }
}

/** Campos de custo gravados no metadata do asset gerado pela chamada (auditoria por asset). */
export function costMetadata(cost: McKitProviderCost | null): Record<string, unknown> {
  if (!cost) return { providerCostUsd: 0 };
  return { providerCostUsd: cost.costUsd, usage: cost.usage, costRate: cost.rate };
}
