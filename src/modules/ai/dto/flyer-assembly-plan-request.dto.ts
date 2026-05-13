import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type FlyerAssemblyLayoutDensity = 'balanced' | 'dense' | 'premium';
export type FlyerAssemblyImageQuality = 'good' | 'poor' | 'missing';
export type FlyerAssemblyRecipeId =
  | 'auto'
  | 'vertical-hero-grid'
  | 'vertical-dense-catalog'
  | 'horizontal-day-panels'
  | 'horizontal-price-campaign';
export type FlyerAssemblyZoneType =
  | 'hero'
  | 'featured'
  | 'category-grid'
  | 'dense-grid'
  | 'strip'
  | 'campaign-panel'
  | 'loose';

export class FlyerAssemblyRectDto {
  @ApiProperty({ example: 75 })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 1632.68 })
  @IsNumber()
  y: number;

  @ApiProperty({ example: 2600 })
  @IsNumber()
  width: number;

  @ApiProperty({ example: 3431.39 })
  @IsNumber()
  height: number;
}

export class FlyerAssemblyTemplateDto {
  @ApiProperty({ example: 'template-1' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ example: 'Ofertas de fim de semana' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'folheto-54x40' })
  @IsOptional()
  @IsString()
  format?: string;

  @ApiPropertyOptional({ type: FlyerAssemblyRectDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => FlyerAssemblyRectDto)
  bodyArea?: FlyerAssemblyRectDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  hasHeader?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  hasFooter?: boolean;
}

export class FlyerAssemblyDocumentDto {
  @ApiProperty({ example: 'Encarte semanal' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  format?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  productCardDefaults?: Record<string, unknown>;
}

export class FlyerAssemblyProductDto {
  @ApiProperty({ example: 'prod-1' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ example: 'Arroz Tipo 1 5kg' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 19.9 })
  @IsNumber()
  price: number;

  @ApiPropertyOptional({ example: 24.9 })
  @IsOptional()
  @IsNumber()
  originalPrice?: number;

  @ApiProperty({ example: 'un' })
  @IsString()
  unit: string;

  @ApiPropertyOptional({ example: 'Mercearia' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  hasImage: boolean;

  @ApiPropertyOptional({ enum: ['good', 'poor', 'missing'], example: 'good' })
  @IsOptional()
  @IsIn(['good', 'poor', 'missing'])
  imageQuality?: FlyerAssemblyImageQuality;

  @ApiPropertyOptional({ example: 'Oferta valida enquanto durar o estoque' })
  @IsOptional()
  @IsString()
  observation?: string;

  @ApiPropertyOptional({ example: 'Produtos a R$ 1,00' })
  @IsOptional()
  @IsString()
  campaignGroup?: string;

  @ApiPropertyOptional({ example: 'Quarta 25/03/2026' })
  @IsOptional()
  @IsString()
  validityLabel?: string;

  @ApiPropertyOptional({ example: 'Quarta' })
  @IsOptional()
  @IsString()
  campaignDay?: string;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsNumber()
  visualPriority?: number;

  @ApiPropertyOptional({ example: 'Super oferta' })
  @IsOptional()
  @IsString()
  offerBadge?: string;

  @ApiPropertyOptional({ enum: ['hero', 'featured', 'category-grid', 'dense-grid', 'strip', 'campaign-panel', 'loose'] })
  @IsOptional()
  @IsIn(['hero', 'featured', 'category-grid', 'dense-grid', 'strip', 'campaign-panel', 'loose'])
  preferredZone?: FlyerAssemblyZoneType;
}

export class FlyerAssemblyOptionsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 120, example: 36 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(120)
  maxProductsPerPage?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  allowMultiplePages?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  preserveCategorySections?: boolean;

  @ApiPropertyOptional({ enum: ['balanced', 'dense', 'premium'], default: 'balanced' })
  @IsOptional()
  @IsIn(['balanced', 'dense', 'premium'])
  layoutDensity?: FlyerAssemblyLayoutDensity;

  @ApiPropertyOptional({
    enum: ['auto', 'vertical-hero-grid', 'vertical-dense-catalog', 'horizontal-day-panels', 'horizontal-price-campaign'],
    default: 'auto',
  })
  @IsOptional()
  @IsIn(['auto', 'vertical-hero-grid', 'vertical-dense-catalog', 'horizontal-day-panels', 'horizontal-price-campaign'])
  recipeId?: FlyerAssemblyRecipeId;
}

export class FlyerAssemblyPlanRequestDto {
  @ApiProperty({ type: FlyerAssemblyTemplateDto })
  @ValidateNested()
  @Type(() => FlyerAssemblyTemplateDto)
  template: FlyerAssemblyTemplateDto;

  @ApiProperty({ type: FlyerAssemblyDocumentDto })
  @ValidateNested()
  @Type(() => FlyerAssemblyDocumentDto)
  document: FlyerAssemblyDocumentDto;

  @ApiProperty({ type: [FlyerAssemblyProductDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FlyerAssemblyProductDto)
  products: FlyerAssemblyProductDto[];

  @ApiPropertyOptional({ type: FlyerAssemblyOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => FlyerAssemblyOptionsDto)
  options?: FlyerAssemblyOptionsDto;
}
