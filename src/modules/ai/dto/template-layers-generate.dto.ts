import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
  IsObject,
} from 'class-validator';

// ─── Request ─────────────────────────────────────────────────────────────────

export class TemplateLayersFormatDto {
  @IsString()
  type: string;

  @IsNumber()
  @Min(1)
  printWidthCm: number;

  @IsNumber()
  @Min(1)
  printHeightCm: number;

  @IsNumber()
  @Min(0.5)
  headerHeightCm: number;

  @IsNumber()
  @Min(0.5)
  footerHeightCm: number;
}

export class CurrentLayerElementDto {
  @IsString()
  id: string;

  @IsString()
  imageUrl: string;

  @IsString()
  prompt: string;

  @IsNumber()
  x: number;

  @IsNumber()
  y: number;

  @IsNumber()
  width: number;

  @IsNumber()
  height: number;

  @IsString()
  section: string;
}

export class CurrentLayersDto {
  @IsOptional()
  @IsObject()
  background?: { imageUrl: string; prompt: string };

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CurrentLayerElementDto)
  elements: CurrentLayerElementDto[];
}

export class TemplateLayersMessageDto {
  @IsEnum(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;

  @IsOptional()
  @IsObject()
  currentLayers?: CurrentLayersDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[]; // reference images attached by user (base64 data URLs)
}

export class TemplateLayersGenerateRequestDto {
  @ValidateNested()
  @Type(() => TemplateLayersFormatDto)
  format: TemplateLayersFormatDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateLayersMessageDto)
  messages: TemplateLayersMessageDto[];
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface LayerElementDto {
  id: string;
  imageUrl: string;
  prompt: string;
  x: number;
  y: number;
  width: number;
  height: number;
  section: 'header' | 'footer';
  zIndex: number;
}

export interface LayerBackgroundDto {
  imageUrl: string;
  prompt: string;
}

export interface LayerBodyBackgroundDto {
  type: 'solid' | 'gradient' | 'image';
  color?: string;
  gradientStart?: string;
  gradientEnd?: string;
  gradientAngle?: number;
  imageUrl?: string;
  imageSize?: string;
  imagePosition?: string;
  imageOpacity?: number;
}

export interface TemplateLayersGenerateResponseDto {
  assistantMessage: string;
  layers: {
    background: LayerBackgroundDto;
    elements: LayerElementDto[];
  };
  bodyBackground: LayerBodyBackgroundDto;
  footerBackground: LayerBodyBackgroundDto;
}
