import { ApiProperty } from '@nestjs/swagger';

/** Um resultado da busca; o endereço da foto original (`imageUrl`) nunca sai (o download usa o `resultId`). */
export class PhotoSearchResultDto {
  @ApiProperty({
    description: 'Opaco para a tela: só vale com o mesmo encarte e item (até 64 caracteres)',
  })
  resultId: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nulo quando a Serper não traz a miniatura',
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Nulo (com a altura) quando a Serper não informa o tamanho',
  })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ description: 'O site que a Serper informa; sem ele, o host do endereço da foto' })
  domain: string;

  @ApiProperty({ description: 'Vazio quando a Serper não traz o título' })
  title: string;

  @ApiProperty({ description: 'Menor lado abaixo de 300 px; falso com o tamanho desconhecido' })
  small: boolean;
}

export class PhotoSearchResponseDto {
  @ApiProperty({ description: 'O termo como o operador mandou, aparado' })
  term: string;

  @ApiProperty()
  page: number;

  @ApiProperty({ description: 'Falso na página sem resultado novo e na página 10' })
  hasMore: boolean;

  @ApiProperty({
    description: 'Verdadeiro quando veio da resposta guardada (24 h), sem chamar a Serper',
  })
  fromCache: boolean;

  @ApiProperty({ type: [PhotoSearchResultDto] })
  results: PhotoSearchResultDto[];
}
