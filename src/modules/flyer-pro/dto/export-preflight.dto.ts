import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import type { ExportPreflightCount } from '../domain/flyer-pro.types';

/**
 * A contagem dos alertas do Pré-flight na hora de exportar (`preflight` do N8), por gravidade. O servidor não conhece
 * os códigos dos alertas: guarda os três números e nenhuma regra os olha (o Pré-flight não barra, PU-47 e PU-48). A
 * chave antiga `blocks` é desconhecida: 400 pelo pipe global.
 */
export class ExportPreflightDto implements ExportPreflightCount {
  @ApiProperty({ minimum: 0, description: 'Alertas de gravidade "problema"' })
  @IsInt()
  @Min(0)
  problems: number;

  @ApiProperty({ minimum: 0, description: 'Alertas de gravidade "aviso"' })
  @IsInt()
  @Min(0)
  warnings: number;

  @ApiProperty({ minimum: 0, description: 'Alertas de gravidade "informação"' })
  @IsInt()
  @Min(0)
  infos: number;
}
