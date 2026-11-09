import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { REFERENCE_LIMITS } from '../domain/scene-reference.types';

/** Corpo de `POST .../reference/generate`: a `revision` da cena que o cliente viu por último. */
export class GenerateReferenceDto {
  @ApiProperty({ minimum: 0, description: '`revision` da cena que o cliente viu por último' })
  @IsInt()
  @Min(0)
  expectedRevision: number;
}

/** Corpo de `POST .../reference/revise`: a correção do cliente à ficha (D-3), em pt-BR. */
export class ReviseReferenceDto extends GenerateReferenceDto {
  @ApiProperty({ minLength: 1, maxLength: REFERENCE_LIMITS.noteMaxLength })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(REFERENCE_LIMITS.noteMaxLength)
  note: string;
}
