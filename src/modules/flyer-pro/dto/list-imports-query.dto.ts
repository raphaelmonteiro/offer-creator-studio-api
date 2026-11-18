import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { FlyerProPagedQueryDto } from './flyer-pro-paged-query.dto';

/**
 * N13: o histórico de importações do encarte. `page` e `limit` como no N2, sem `search` (o histórico não tem busca por
 * nome: `search` é parâmetro desconhecido, 400 pelo pipe global); `fileHash` é comparado exatamente.
 */
export class ListFlyerProImportsQueryDto extends OmitType(FlyerProPagedQueryDto, [
  'search',
] as const) {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: FLYER_PRO_LIMITS.importFileHashMaxLength,
    description: 'Só as importações desse arquivo (o hash do conteúdo, calculado no front)',
    example: '9f2c1a7b3d4e5f60',
  })
  @IsOptional()
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.importFileHashMaxLength)
  fileHash?: string;
}
