import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Cliente do encarte em edição. A imagem passa a ser preferida dele (client_preferred_images): bônus na porcentagem e desempate nas próximas buscas.',
    example: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
  })
  @IsOptional()
  @IsUUID('4')
  clientId?: string | null;
}
