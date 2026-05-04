import { ApiProperty } from '@nestjs/swagger';

export type ProductCategoryAssignmentSource = 'ai' | 'existing' | 'fallback';

export class ProductCategoryAssignmentDto {
  @ApiProperty({ example: 'import-1' })
  productId: string;

  @ApiProperty({ example: 'Mercearia' })
  category: string;

  @ApiProperty({ minimum: 0, maximum: 1, example: 0.92 })
  confidence: number;

  @ApiProperty({ enum: ['ai', 'existing', 'fallback'] })
  source: ProductCategoryAssignmentSource;

  @ApiProperty({ required: false, example: 'Produto seco de prateleira.' })
  reason?: string;
}

export class ProductCategorizationSummaryDto {
  @ApiProperty({ example: 120 })
  total: number;

  @ApiProperty({ example: 113 })
  categorized: number;

  @ApiProperty({ example: 7 })
  uncertain: number;
}

export class ProductCategorizationResponseDto {
  @ApiProperty({ type: [ProductCategoryAssignmentDto] })
  assignments: ProductCategoryAssignmentDto[];

  @ApiProperty({ type: ProductCategorizationSummaryDto })
  summary: ProductCategorizationSummaryDto;
}
