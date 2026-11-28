import { ApiProperty } from '@nestjs/swagger';

/** A foto baixada e registrada na Galeria (B2): a medida é a do arquivo, com a orientação do EXIF aplicada. */
export class PhotoDownloadResponseDto {
  @ApiProperty({ description: 'Endereço em uploads/products/' })
  imageUrl: string;

  @ApiProperty({ description: 'O id da linha nova de gallery_images' })
  imageId: string;

  @ApiProperty()
  width: number;

  @ApiProperty()
  height: number;

  @ApiProperty({ description: 'Menor lado do arquivo abaixo de 300 px' })
  small: boolean;
}
