import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export const GUIDED_TEMPLATE_LAYOUT_MODES = [
  'full',
  'header-only',
  'footer-only',
  'body-only',
] as const;
export const GUIDED_TEMPLATE_SECTIONS = ['header', 'body', 'footer'] as const;
export const GUIDED_TEMPLATE_BACKGROUND_TYPES = ['solid', 'gradient', 'reference-image'] as const;
export const GUIDED_TEMPLATE_INTENSITIES = ['subtle', 'balanced', 'impactful'] as const;
export const GUIDED_TEMPLATE_STYLE_MODES = [
  'realistic',
  'advertising',
  'illustrated',
  '3d',
  'artistic',
  'custom',
] as const;
export const GUIDED_TEMPLATE_DENSITIES = ['clean', 'balanced', 'rich'] as const;
export const GUIDED_TEMPLATE_HORIZONTAL_ALIGNMENTS = ['left', 'center', 'right'] as const;
export const GUIDED_TEMPLATE_ELEMENT_STATUS = ['planned', 'generated'] as const;
export const GUIDED_TEMPLATE_STEPS = [
  'structure',
  'background-base',
  'background-overrides',
  'style-profile',
  'elements',
  'review',
] as const;

export type GuidedTemplateLayoutMode = (typeof GUIDED_TEMPLATE_LAYOUT_MODES)[number];
export type GuidedTemplateSection = (typeof GUIDED_TEMPLATE_SECTIONS)[number];
export type GuidedTemplateBackgroundType = (typeof GUIDED_TEMPLATE_BACKGROUND_TYPES)[number];
export type GuidedTemplateIntensity = (typeof GUIDED_TEMPLATE_INTENSITIES)[number];
export type GuidedTemplateStyleMode = (typeof GUIDED_TEMPLATE_STYLE_MODES)[number];
export type GuidedTemplateDensity = (typeof GUIDED_TEMPLATE_DENSITIES)[number];
export type GuidedTemplateHorizontalAlignment =
  (typeof GUIDED_TEMPLATE_HORIZONTAL_ALIGNMENTS)[number];
export type GuidedTemplateElementStatus = (typeof GUIDED_TEMPLATE_ELEMENT_STATUS)[number];
export type GuidedTemplateStep = (typeof GUIDED_TEMPLATE_STEPS)[number];

export class TemplateLayersGuidedStructureDto {
  @IsString()
  type: string;

  @IsNumber()
  @Min(1)
  printWidthCm: number;

  @IsNumber()
  @Min(1)
  printHeightCm: number;

  @IsEnum(GUIDED_TEMPLATE_LAYOUT_MODES)
  layoutMode: GuidedTemplateLayoutMode;

  @IsOptional()
  @IsNumber()
  @Min(0)
  headerHeightCm?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  footerHeightCm?: number;
}

export class TemplateLayersGuidedBackgroundDto {
  @IsEnum(GUIDED_TEMPLATE_BACKGROUND_TYPES)
  type: GuidedTemplateBackgroundType;

  @IsOptional()
  @Matches(/^#([0-9A-Fa-f]{6})$/)
  color?: string;

  @IsOptional()
  @Matches(/^#([0-9A-Fa-f]{6})$/)
  gradientStart?: string;

  @IsOptional()
  @Matches(/^#([0-9A-Fa-f]{6})$/)
  gradientEnd?: string;

  @IsOptional()
  @IsNumber()
  gradientAngle?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_INTENSITIES)
  intensity?: GuidedTemplateIntensity;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class TemplateLayersGuidedSectionBackgroundsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedBackgroundDto)
  header?: TemplateLayersGuidedBackgroundDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedBackgroundDto)
  body?: TemplateLayersGuidedBackgroundDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedBackgroundDto)
  footer?: TemplateLayersGuidedBackgroundDto;
}

export class TemplateLayersGuidedStyleProfileDto {
  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_STYLE_MODES)
  styleMode?: GuidedTemplateStyleMode;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_DENSITIES)
  density?: GuidedTemplateDensity;

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_SECTIONS)
  focusSection?: GuidedTemplateSection;

  @IsOptional()
  @IsString()
  customStylePrompt?: string;
}

export class TemplateLayersGuidedReservedAreaDto {
  @IsEnum(GUIDED_TEMPLATE_SECTIONS)
  section: GuidedTemplateSection;

  @IsString()
  purpose: string;

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_HORIZONTAL_ALIGNMENTS)
  align?: GuidedTemplateHorizontalAlignment;

  @IsOptional()
  @IsNumber()
  @Min(1)
  widthPct?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class TemplateLayersGuidedElementDto {
  @IsString()
  id: string;

  @IsString()
  name: string;

  @IsEnum(GUIDED_TEMPLATE_SECTIONS)
  section: GuidedTemplateSection;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_STYLE_MODES)
  styleMode?: GuidedTemplateStyleMode;

  @IsOptional()
  @IsString()
  customStylePrompt?: string;

  @IsOptional()
  @IsString()
  positionHint?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  sizePct?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_ELEMENT_STATUS)
  status?: GuidedTemplateElementStatus;
}

export class TemplateLayersGuidedDraftDto {
  @ValidateNested()
  @Type(() => TemplateLayersGuidedStructureDto)
  structure: TemplateLayersGuidedStructureDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedBackgroundDto)
  globalBackground?: TemplateLayersGuidedBackgroundDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedSectionBackgroundsDto)
  sectionBackgrounds?: TemplateLayersGuidedSectionBackgroundsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedStyleProfileDto)
  styleProfile?: TemplateLayersGuidedStyleProfileDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateLayersGuidedReservedAreaDto)
  reservedAreas?: TemplateLayersGuidedReservedAreaDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateLayersGuidedElementDto)
  elements?: TemplateLayersGuidedElementDto[];

  @IsOptional()
  @IsArray()
  @IsEnum(GUIDED_TEMPLATE_SECTIONS, { each: true })
  lockedSections?: GuidedTemplateSection[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lockedElementIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  referenceImages?: string[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsEnum(GUIDED_TEMPLATE_STEPS)
  currentStep?: GuidedTemplateStep;

  @IsOptional()
  @IsString()
  lastUpdatedAt?: string;
}

export class CreateTemplateLayersGuidedDraftRequestDto {
  @ValidateNested()
  @Type(() => TemplateLayersGuidedStructureDto)
  structure: TemplateLayersGuidedStructureDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedBackgroundDto)
  globalBackground?: TemplateLayersGuidedBackgroundDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedSectionBackgroundsDto)
  sectionBackgrounds?: TemplateLayersGuidedSectionBackgroundsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedStyleProfileDto)
  styleProfile?: TemplateLayersGuidedStyleProfileDto;
}

export class UpdateTemplateLayersGuidedStructureRequestDto {
  @ValidateNested()
  @Type(() => TemplateLayersGuidedDraftDto)
  draft: TemplateLayersGuidedDraftDto;

  @ValidateNested()
  @Type(() => TemplateLayersGuidedStructureDto)
  structure: TemplateLayersGuidedStructureDto;
}

export class UpdateTemplateLayersGuidedBackgroundsRequestDto {
  @ValidateNested()
  @Type(() => TemplateLayersGuidedDraftDto)
  draft: TemplateLayersGuidedDraftDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedBackgroundDto)
  globalBackground?: TemplateLayersGuidedBackgroundDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedSectionBackgroundsDto)
  sectionBackgrounds?: TemplateLayersGuidedSectionBackgroundsDto;
}

export class UpdateTemplateLayersGuidedStyleRequestDto {
  @ValidateNested()
  @Type(() => TemplateLayersGuidedDraftDto)
  draft: TemplateLayersGuidedDraftDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateLayersGuidedStyleProfileDto)
  styleProfile?: TemplateLayersGuidedStyleProfileDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateLayersGuidedReservedAreaDto)
  reservedAreas?: TemplateLayersGuidedReservedAreaDto[];
}

export class UpdateTemplateLayersGuidedElementsRequestDto {
  @ValidateNested()
  @Type(() => TemplateLayersGuidedDraftDto)
  draft: TemplateLayersGuidedDraftDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateLayersGuidedElementDto)
  elements?: TemplateLayersGuidedElementDto[];

  @IsOptional()
  @IsArray()
  @IsEnum(GUIDED_TEMPLATE_SECTIONS, { each: true })
  lockedSections?: GuidedTemplateSection[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lockedElementIds?: string[];
}

export interface TemplateLayersGuidedPreviewBackgroundDto {
  type: GuidedTemplateBackgroundType | 'default';
  color?: string;
  gradientStart?: string;
  gradientEnd?: string;
  gradientAngle?: number;
  images?: string[];
  intensity?: GuidedTemplateIntensity;
  notes?: string;
  source: 'global' | 'override' | 'default';
}

export interface TemplateLayersGuidedPreviewSectionDto {
  section: GuidedTemplateSection;
  active: boolean;
  widthCm: number;
  heightCm: number;
  widthPx: number;
  heightPx: number;
  background: TemplateLayersGuidedPreviewBackgroundDto;
}

export interface TemplateLayersGuidedPreviewDto {
  widthPx: number;
  heightPx: number;
  bodyHeightCm: number;
  sections: TemplateLayersGuidedPreviewSectionDto[];
}

export interface TemplateLayersGuidedDraftResultDto {
  assistantMessage: string;
  draft: TemplateLayersGuidedDraftDto;
  preview: TemplateLayersGuidedPreviewDto;
  nextStep: GuidedTemplateStep;
}
