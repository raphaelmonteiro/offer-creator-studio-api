import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { textOrNull } from './flyer-pro-enrich-input';
import type { EnrichItemInput, SpellVerdict } from '../providers/flyer-pro-enrich.port';

/**
 * A leitura da resposta da ortografia (A-6): só a primeira correção do item com `field: "name"` vale; a sugestão é
 * aparada e só serve se for diferente do nome e couber no `name` (de 1 a 120 caracteres, regra da 09). O resto é "nome
 * sem erro" (`clean`): o item fica conferido, sem sugestão. O serviço nunca devolve "sem resposta" para o item: ou falha
 * a chamada inteira, ou o item não tem correção.
 */

/** O que o job lê de uma correção do serviço (a `CorrectionDto`, sem importá-la). */
export interface SpellCorrection {
  productId: string;
  field: string;
  suggestion: string;
}

export function spellVerdictOf(
  item: Pick<EnrichItemInput, 'id' | 'name'>,
  corrections: SpellCorrection[],
): SpellVerdict {
  const first = corrections.find((c) => c.productId === item.id && c.field === 'name');
  const value = textOrNull(first?.suggestion);
  const usable =
    value !== null &&
    value !== item.name.trim() &&
    value.length <= FLYER_PRO_LIMITS.itemNameMaxLength;
  return usable
    ? { itemId: item.id, action: 'suggest', value }
    : { itemId: item.id, action: 'clean' };
}
