import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

export class RestoreVersionDto {
  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Opcional: `revision` vista pelo cliente; diferente da atual dá 409 REVISION_CONFLICT',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
