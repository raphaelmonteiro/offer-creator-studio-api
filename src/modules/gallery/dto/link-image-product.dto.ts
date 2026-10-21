import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LinkImageProductDto {
  @ApiProperty({
    example: 'LING TOSCANA SEARA KG',
    description:
      'Nome do produto como veio na lista do encarte. Fica gravado na imagem para a próxima lista com o mesmo nome.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  productName: string;

  @ApiPropertyOptional({
    example: '7891000100103',
    description: 'EAN/GTIN do produto, quando a lista trouxe. Também fica gravado na imagem.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  ean?: string | null;
}
