import { flyerProBadRequest, flyerProMissingFields, flyerProUiTooLarge } from './flyer-pro.errors';
import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { isSent, missingFields } from './flyer-pro-presence';
import { jsonBytes } from './flyer-pro-slices';
import { FLYER_PRO_STEPS } from './flyer-pro-steps';

/**
 * As conferências do cursor antes do banco: `step` à mão (o pipe pula o corpo `{}`) e o tamanho do `ui`. `ui` ausente ou
 * nulo não tem tamanho (mantém o atual).
 */
export function assertCursorBody(body: { step?: unknown; ui?: unknown }): void {
  const missing = missingFields(body, ['step']);
  if (missing.length > 0) throw flyerProMissingFields(missing);
  if (!(FLYER_PRO_STEPS as readonly unknown[]).includes(body.step)) {
    throw flyerProBadRequest(`Etapa inválida: use uma de ${FLYER_PRO_STEPS.join(', ')}.`);
  }
  if (!isSent(body.ui)) return;
  const bytes = jsonBytes(body.ui);
  if (bytes > FLYER_PRO_LIMITS.uiMaxBytes) {
    throw flyerProUiTooLarge({ bytes, max: FLYER_PRO_LIMITS.uiMaxBytes });
  }
}
