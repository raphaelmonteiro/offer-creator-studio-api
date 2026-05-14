import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateImageDto {
  @ApiProperty({ example: 'leite condensado moca.png' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;
}
