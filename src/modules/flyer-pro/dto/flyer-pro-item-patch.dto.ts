import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { FlyerProItemEntry } from '../domain/flyer-pro-item.types';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/**
 * Um item de `items.upsert` (N4): só a forma (400). Os valores (tamanho do nome, unidade, categoria, preço, EAN, foto)
 * são do validador de domínio (422, `issues`). Ausente não muda, `null` limpa. `categorySource`, `imageStatus` e as
 * revisões não existem aqui: o servidor os escreve, e enviá-los é campo desconhecido (400).
 */
export class FlyerProItemPatchDto implements FlyerProItemEntry {
  @ApiProperty()
  @IsUUID()
  id: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(FLYER_PRO_LIMITS.versionMax)
  position?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Nome como veio na planilha; só na criação' })
  @IsOptional()
  @IsString()
  sourceName?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  price?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAlcoholic?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ean?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  galleryImageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  imageWidth?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  imageHeight?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageOrigin?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Até 2 KB; só na criação',
  })
  @IsOptional()
  @IsObject()
  imported?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'A importação que criou o item (a de `import` no mesmo corpo ou uma do encarte); só na criação',
  })
  @IsOptional()
  @IsUUID()
  importId?: string;

  @ApiPropertyOptional({ enum: ['accept', 'reject', 'blocked'] })
  @IsOptional()
  @IsIn(['accept', 'reject', 'blocked'])
  categoryDecision?: 'accept' | 'reject' | 'blocked';

  @ApiPropertyOptional({ maxLength: FLYER_PRO_LIMITS.decisionReasonMaxLength })
  @IsOptional()
  @IsString()
  @MaxLength(FLYER_PRO_LIMITS.decisionReasonMaxLength)
  categoryDecisionReason?: string;

  @ApiPropertyOptional({ enum: ['reject'] })
  @IsOptional()
  @IsIn(['reject'])
  imageDecision?: 'reject';

  @ApiPropertyOptional({ enum: ['accept', 'reject'] })
  @IsOptional()
  @IsIn(['accept', 'reject'])
  spellDecision?: 'accept' | 'reject';
}
