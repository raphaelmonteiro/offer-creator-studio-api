import { IsString, IsNotEmpty, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ImageDownloadRequestDto {
  @ApiProperty({ description: 'URL da imagem selecionada no Pixabay (fullUrl retornado na busca)' })
  @IsString()
  @IsUrl()
  imageUrl: string;

  @ApiProperty({ description: 'Nome do produto — usado para gerar o nome do arquivo' })
  @IsString()
  @IsNotEmpty()
  productName: string;
}
