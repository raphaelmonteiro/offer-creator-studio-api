import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsUUID, ValidateNested } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { FlyerProItemPatchDto } from './flyer-pro-item-patch.dto';
import { ValidateIfDefined } from './validate-if-defined.decorator';

/**
 * O ramo `items` do `PATCH` (N4): incluir ou alterar (`upsert`), excluir (`delete`) e substituir todos (`replaceAll`).
 * Chave ausente vale lista vazia e `false`; `null` é 400.
 */
export class FlyerProItemsPatchDto {
  @ApiPropertyOptional({
    type: [FlyerProItemPatchDto],
    description: 'Item novo: completo. Item existente: só o que mudou',
  })
  @ValidateIfDefined()
  @IsArray()
  @ArrayMaxSize(FLYER_PRO_LIMITS.itemMax)
  @ValidateNested({ each: true })
  @Type(() => FlyerProItemPatchDto)
  upsert?: FlyerProItemPatchDto[];

  @ApiPropertyOptional({ description: 'Ids a apagar; o que não é do encarte é ignorado' })
  @ValidateIfDefined()
  @IsArray()
  @ArrayMaxSize(FLYER_PRO_LIMITS.itemMax)
  @IsUUID(undefined, { each: true })
  delete?: string[];

  @ApiPropertyOptional({ description: 'Apaga os itens do encarte que não vieram em `upsert`' })
  @ValidateIfDefined()
  @IsBoolean()
  replaceAll?: boolean;
}
