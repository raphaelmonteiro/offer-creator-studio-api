import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

/** Corpo de `POST .../faces/back/derive`: a `revision` da cena que o cliente viu por último. */
export class DeriveFaceDto {
  @ApiProperty({ minimum: 0, description: '`revision` da cena que o cliente viu por último' })
  @IsInt()
  @Min(0)
  expectedRevision: number;
}
