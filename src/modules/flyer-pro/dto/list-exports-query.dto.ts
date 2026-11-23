import { OmitType } from '@nestjs/swagger';
import { FlyerProPagedQueryDto } from './flyer-pro-paged-query.dto';

/**
 * N9: o histórico de exportações do encarte. `page` e `limit` como no N2, sem filtro próprio e sem `search` (o histórico
 * não tem busca por nome: `search` é parâmetro desconhecido, 400 pelo pipe global).
 */
export class ListFlyerProExportsQueryDto extends OmitType(FlyerProPagedQueryDto, [
  'search',
] as const) {}
