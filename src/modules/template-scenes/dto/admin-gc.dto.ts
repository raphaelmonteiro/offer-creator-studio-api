import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class AdminGcDto {
  @ApiPropertyOptional({
    description: 'Simula sem apagar; ausente = o valor de TEMPLATE_SCENE_GC_DRY_RUN (padrão true)',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
