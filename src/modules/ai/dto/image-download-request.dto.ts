import { IsString, IsNotEmpty, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImageDownloadRequestDto {
  @ApiProperty({ description: 'URL da imagem selecionada no Pixabay (fullUrl retornado na busca)' })
  @IsString()
  // Sem exigir domínio (`localhost` chega à recusa do download, HTTP 200) e sem exigir o esquema: o endereço sem esquema
  // passa o DTO como hoje e é recusado pelo download antes de qualquer conexão (PV-24 da change 47).
  @IsUrl({ require_tld: false })
  imageUrl: string;

  @ApiProperty({ description: 'Nome do produto — usado para gerar o nome do arquivo' })
  @IsString()
  @IsNotEmpty()
  productName: string;
}
