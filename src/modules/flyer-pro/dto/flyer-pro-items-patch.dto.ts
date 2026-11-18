import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { FlyerProItemPatchDto } from './flyer-pro-item-patch.dto';

/** O ramo `items` do `PATCH` (N4): incluir ou alterar (`upsert`), excluir (`delete`) e substituir todos (`replaceAll`). */
export class FlyerProItemsPatchDto {
  @ApiPropertyOptional({
    type: [FlyerProItemPatchDto],
    description: 'Item novo: completo. Item existente: só o que mudou',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FLYER_PRO_LIMITS.itemMax)
  @ValidateNested({ each: true })
  @Type(() => FlyerProItemPatchDto)
  upsert?: FlyerProItemPatchDto[];

  @ApiPropertyOptional({ description: 'Ids a apagar; o que não é do encarte é ignorado' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FLYER_PRO_LIMITS.itemMax)
  @IsUUID(undefined, { each: true })
  delete?: string[];

  @ApiPropertyOptional({ description: 'Apaga os itens do encarte que não vieram em `upsert`' })
  @IsOptional()
  @IsBoolean()
  replaceAll?: boolean;
}
