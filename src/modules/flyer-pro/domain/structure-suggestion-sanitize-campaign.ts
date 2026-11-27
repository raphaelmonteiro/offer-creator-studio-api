import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { clipText } from './structure-suggestion-clip-text';
import type { RawStructureSuggestion, SuggestedCampaign } from './structure-suggestion.types';

/**
 * A campanha que o modelo leu no nome do encarte (decisão 3 do dono): `kind` `none` ou rótulo vazio (depois de aparado)
 * valem `null`, sem entrada em `discarded`; o rótulo é cortado em 60 caracteres, sem reticências. A campanha só informa:
 * não muda nada sozinha nem conta em `noChange`.
 */
export function sanitizeCampaign(
  campaign: RawStructureSuggestion['campaign'],
): SuggestedCampaign | null {
  const label = clipText(campaign.label, FLYER_PRO_LIMITS.structureCampaignLabelMaxLength);
  if (campaign.kind === 'none' || label === '') return null;
  return { kind: campaign.kind, label };
}
