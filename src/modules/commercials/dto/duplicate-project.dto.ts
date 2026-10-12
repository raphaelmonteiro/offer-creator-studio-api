import { IsIn, IsOptional } from 'class-validator';
import {
  MC_ASPECT_RATIOS,
  MC_PROJECT_TIERS,
  McAspectRatio,
  McProjectTier,
} from '../domain/mc-types';

/**
 * POST /commercials/projects/:id/duplicate — "duplicar em outro formato"
 * (plano §7.2) e "duplicar em outro tier" (change video-formatos-personagem,
 * D6). Omitir `aspectRatio`/`tier` copia os da origem. Aceita os quatro
 * aspectos (4:5 incluído, design D12); a regra `scenes` × 4:5 é do service
 * (422), não da forma. Tier fora do enum → 400 pelo pipe global (D13).
 */
export class DuplicateProjectDto {
  @IsOptional()
  @IsIn(MC_ASPECT_RATIOS as readonly string[])
  aspectRatio?: McAspectRatio;

  /** `economico` | `premium` — "duplicar como econômico" após falha do motor premium. */
  @IsOptional()
  @IsIn(MC_PROJECT_TIERS as readonly string[])
  tier?: McProjectTier;
}
