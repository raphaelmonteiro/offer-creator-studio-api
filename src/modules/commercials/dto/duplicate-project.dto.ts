import { IsIn, IsOptional } from 'class-validator';
import { MC_ASPECT_RATIOS, McAspectRatio } from '../domain/mc-types';

/**
 * POST /commercials/projects/:id/duplicate — "duplicar em outro formato"
 * (plano §7.2). Omitir `aspectRatio` copia o formato do projeto de origem.
 */
export class DuplicateProjectDto {
  @IsOptional()
  @IsIn(MC_ASPECT_RATIOS as readonly string[])
  aspectRatio?: McAspectRatio;
}
