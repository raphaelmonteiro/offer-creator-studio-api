import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/**
 * O corpo do download da foto escolhida (B2): só o `resultId` de um resultado da resposta guardada do encarte e item. Não
 * existe campo de endereço: qualquer outro campo (`imageUrl` inclusive) é 400 (`forbidNonWhitelisted`). O pipe global pula o
 * corpo `{}`: o serviço confere o `resultId` à mão.
 */
export class PhotoDownloadDto {
  @ApiProperty({
    minLength: 1,
    maxLength: FLYER_PRO_LIMITS.photoResultIdMaxLength,
    description: 'O resultId de um resultado da busca guardada deste encarte e item',
  })
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.photoResultIdMaxLength)
  resultId: string;
}
