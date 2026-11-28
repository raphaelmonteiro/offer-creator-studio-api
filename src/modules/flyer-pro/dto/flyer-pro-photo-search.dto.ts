import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { ValidateIfDefined } from './validate-if-defined.decorator';

const LIMITS = FLYER_PRO_LIMITS;

/**
 * O corpo da busca de fotos do item (B1). País, idioma e quantidade são fixos no servidor: qualquer outro campo é 400
 * (`forbidNonWhitelisted`). O pipe global pula o corpo `{}`: o serviço confere o `term` à mão.
 */
export class PhotoSearchDto {
  @ApiProperty({
    minLength: 1,
    maxLength: LIMITS.photoSearchTermMaxLength,
    description: 'O termo buscado no Google Imagens; de 1 a 120 caracteres depois de aparar',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, LIMITS.photoSearchTermMaxLength)
  term: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: LIMITS.photoSearchPageMax,
    description: 'A página de 10 resultados; ausente vale 1, e `null` é recusado',
  })
  @ValidateIfDefined()
  @IsInt()
  @Min(1)
  @Max(LIMITS.photoSearchPageMax)
  page?: number;
}
