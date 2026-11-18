import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { FlyerProPagedQueryDto } from './flyer-pro-paged-query.dto';

/** N2: a lista de encartes. Cliente que não existe não é erro: o filtro devolve a lista vazia. */
export class QueryFlyerProDocumentsDto extends FlyerProPagedQueryDto {
  @ApiPropertyOptional({ description: 'Só os encartes desse cliente' })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
