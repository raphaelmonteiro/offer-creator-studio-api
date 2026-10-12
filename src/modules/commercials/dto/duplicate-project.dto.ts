import { IsIn, IsOptional } from 'class-validator';
import { MC_ASPECT_RATIOS, McAspectRatio } from '../domain/mc-types';

/**
 * POST /commercials/projects/:id/duplicate — "duplicar em outro formato"
 * (plano §7.2). Omitir `aspectRatio` copia o formato do projeto de origem.
 * Aceita os quatro aspectos (4:5 incluído, design D12); a regra `scenes` × 4:5
 * é do service (422), não da forma.
 */
export class DuplicateProjectDto {
  @IsOptional()
  @IsIn(MC_ASPECT_RATIOS as readonly string[])
  aspectRatio?: McAspectRatio;
}
