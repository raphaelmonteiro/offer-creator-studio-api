import type { SpellCheckService } from '../../ai/spell-check.service';
import { spellVerdictOf } from '../domain/flyer-pro-enrich-spell';
import type {
  EnrichCallContext,
  EnrichItemInput,
  SpellVerdict,
} from '../providers/flyer-pro-enrich.port';
import { strictCall } from '../providers/flyer-pro-enrich.strict';

/** O que a fase usa do serviço de ortografia (`SpellCheckService`). */
export type SpellCheckApi = Pick<SpellCheckService, 'isAvailable' | 'spellCheck'>;

/**
 * A fase de ortografia do provedor real (U2.5): chama a ortografia que o `/editor-v2` já usa, só com o nome do item (sem
 * `observation` nem `badgeText`). Uma das chamadas paralelas do serviço que falhe derruba o lote inteiro: ninguém recebe
 * `spellReview` nessa tentativa. A correção vira sugestão pendente, nunca é aplicada (regras em
 * `domain/flyer-pro-enrich-spell.ts`).
 */
export class EnrichSpellPhase {
  constructor(private readonly service: SpellCheckApi) {}

  isAvailable(): boolean {
    return this.service.isAvailable();
  }

  async run(items: EnrichItemInput[], context: EnrichCallContext): Promise<SpellVerdict[]> {
    const products = items.map((item) => ({ id: item.id, name: item.name }));
    const { corrections } = await strictCall(() =>
      this.service.spellCheck(products, { usage: context.usage, signal: context.signal }),
    );
    return items.map((item) => spellVerdictOf(item, corrections));
  }
}
