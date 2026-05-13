import { ApiProperty } from '@nestjs/swagger';

export class ProductImageMatchItemDto {
  @ApiProperty({ example: 'import-1' })
  productId: string;

  @ApiProperty({ example: 'b2f0ed1e-...' })
  imageId: string;

  @ApiProperty({ example: 'https://cdn.example.com/uploads/gallery/arroz.jpg' })
  imageUrl: string;

  @ApiProperty({ example: 0.92, description: 'Similaridade 0..1 (1 = idêntico)' })
  score: number;
}

export class ProductImageMatchResponseDto {
  @ApiProperty({ type: [ProductImageMatchItemDto] })
  matches: ProductImageMatchItemDto[];

  @ApiProperty({ example: 10, description: 'Total de produtos avaliados' })
  scanned: number;

  @ApiProperty({ example: 7, description: 'Produtos com match acima do threshold' })
  matched: number;
}
