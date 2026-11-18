import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsObject, IsOptional, IsUUID, ArrayMaxSize } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/** O ramo `items` do `PATCH` (N4): incluir ou alterar (`upsert`), excluir (`delete`) e substituir todos (`replaceAll`). */
export class FlyerProItemsPatchDto {
  @ApiPropertyOptional({ description: 'Item novo: completo. Item existente: só o que mudou' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FLYER_PRO_LIMITS.itemMax)
  @IsObject({ each: true })
  upsert?: Array<Record<string, unknown>>;

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
