import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProductImageCandidateDto {
  @ApiProperty()
  imageId: string;

  @ApiProperty()
  url: string;

  @ApiPropertyOptional({ nullable: true })
  thumbnailUrl: string | null;

  @ApiProperty()
  filename: string;

  @ApiPropertyOptional({ nullable: true })
  folderName: string | null;

  @ApiProperty({ example: 0.92, description: 'Similaridade 0..1 (1 = idêntico)' })
  score: number;
}

export class ProductImageCandidatesResponseDto {
  @ApiProperty({ type: [ProductImageCandidateDto] })
  candidates: ProductImageCandidateDto[];
}
