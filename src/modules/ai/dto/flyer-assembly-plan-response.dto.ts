import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type FlyerAssemblySectionLayout = 'balanced-grid' | 'dense-grid' | 'hero-grid';
export type FlyerAssemblyPlanSource = 'ai' | 'fallback';

export class FlyerAssemblySectionPlanDto {
  @ApiProperty({ example: 'Hortifruti' })
  category: string;

  @ApiProperty({ example: 'Hortifruti' })
  title: string;

  @ApiProperty({ example: 90 })
  priority: number;

  @ApiProperty({ enum: ['balanced-grid', 'dense-grid', 'hero-grid'] })
  layout: FlyerAssemblySectionLayout;

  @ApiProperty({ type: [String], example: ['prod-1', 'prod-2'] })
  productIds: string[];

  @ApiProperty({ type: [String], example: ['prod-1'] })
  featuredProductIds: string[];
}

export class FlyerAssemblyPagePlanDto {
  @ApiPropertyOptional({ example: 'Pagina 1' })
  name?: string;

  @ApiProperty({ type: [FlyerAssemblySectionPlanDto] })
  sections: FlyerAssemblySectionPlanDto[];
}

export class FlyerAssemblySummaryDto {
  @ApiProperty({ example: 120 })
  totalProducts: number;

  @ApiProperty({ example: 118 })
  placedProducts: number;

  @ApiProperty({ example: 2 })
  unplacedProducts: number;

  @ApiProperty({ example: 4 })
  pageCount: number;

  @ApiProperty({ enum: ['ai', 'fallback'] })
  source: FlyerAssemblyPlanSource;
}

export class FlyerAssemblyPlanResponseDto {
  @ApiProperty({ type: [FlyerAssemblyPagePlanDto] })
  pages: FlyerAssemblyPagePlanDto[];

  @ApiProperty({ type: [String], example: [] })
  unplacedProductIds: string[];

  @ApiProperty({ type: [String], example: ['Plano gerado com IA.'] })
  notes: string[];

  @ApiProperty({ type: FlyerAssemblySummaryDto })
  summary: FlyerAssemblySummaryDto;
}
