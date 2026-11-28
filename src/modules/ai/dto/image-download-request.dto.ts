import { IsString, IsNotEmpty, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImageDownloadRequestDto {
  @ApiProperty({ description: 'URL da imagem selecionada no Pixabay (fullUrl retornado na busca)' })
  @IsString()
  // Sem exigir domínio (`localhost` chega à recusa do download, HTTP 200) e com o esquema obrigatório (`abc` é 400).
  @IsUrl({ require_tld: false, require_protocol: true })
  imageUrl: string;

  @ApiProperty({ description: 'Nome do produto — usado para gerar o nome do arquivo' })
  @IsString()
  @IsNotEmpty()
  productName: string;
}
