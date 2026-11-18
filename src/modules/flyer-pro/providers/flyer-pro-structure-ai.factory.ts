import type { StructureAiConfig } from '../config/structure-ai.config';
import { MockFlyerProStructureAi } from './flyer-pro-structure-ai.mock';
import type { FlyerProStructureAiPort } from './flyer-pro-structure-ai.port';

/**
 * Escolhe o provedor por `FLYER_PRO_STRUCTURE_AI_PROVIDER` (já resolvido em `real` ou `mock` pela configuração, que avisa
 * no log do valor desconhecido). Por enquanto todo valor devolve o simulado: o provedor real entra atrás desta mesma porta
 * na task 1.12.
 */
export function createStructureAiPort(_config: StructureAiConfig): FlyerProStructureAiPort {
  return new MockFlyerProStructureAi();
}
