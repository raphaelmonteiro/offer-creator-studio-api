import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateFontDto {
  @ApiProperty({ example: 'Bebas Neue' })
  @IsString()
  family: string;

  @ApiProperty({ example: '400' })
  @IsString()
  weight: string;

  @ApiProperty({ example: 'normal' })
  @IsString()
  style: string;
}
