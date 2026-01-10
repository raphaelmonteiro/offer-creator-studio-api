import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class DuplicateFlyerDto {
  @ApiProperty({ example: 'Ofertas de Janeiro - Cópia' })
  @IsString()
  name: string;
}
