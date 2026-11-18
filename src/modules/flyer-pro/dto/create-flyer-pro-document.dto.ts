import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

/**
 * N1: os seis campos do Setup. `format`, `pageCount`, `step`, `templateSnapshot` e `revision` são só do servidor, então
 * o pipe global (`forbidNonWhitelisted`) os recusa no corpo.
 */
export class CreateFlyerProDocumentDto {
  @ApiProperty({ description: 'Chave de idempotência da criação (UUID gerado no Setup)' })
  @IsUUID()
  creationKey: string;

  @ApiProperty({ minLength: 1, maxLength: FLYER_PRO_LIMITS.nameMaxLength })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, FLYER_PRO_LIMITS.nameMaxLength)
  name: string;

  @ApiProperty()
  @IsUUID()
  clientId: string;

  @ApiProperty({ description: 'Cena do Templates v2 que serve de template' })
  @IsUUID()
  sceneId: string;

  @ApiProperty({ minimum: 1, maximum: FLYER_PRO_LIMITS.versionMax })
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  schemaVersion: number;

  @ApiProperty({ minimum: 1, maximum: FLYER_PRO_LIMITS.versionMax })
  @IsInt()
  @Min(1)
  @Max(FLYER_PRO_LIMITS.versionMax)
  engineVersion: number;
}
