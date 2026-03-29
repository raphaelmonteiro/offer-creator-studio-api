import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImageSearchRequestDto {
  @ApiProperty({ description: 'Nome original do produto (o backend normaliza o termo de busca)' })
  @IsString()
  @IsNotEmpty()
  rawName: string;
}
