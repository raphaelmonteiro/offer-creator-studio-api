import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

/**
 * Dimensions of the section being edited, in centimeters.
 * The LLM uses this to reason about positions in "physical" terms even
 * though it actually returns preview-pixel coordinates.
 */
export class SocialSectionDimensionsDto {
  @IsNumber()
  widthCm: number;

  @IsNumber()
  heightCm: number;

  /**
   * Section width and height in preview pixels (72dpi). This is the
   * coordinate system the LLM should think in for x/y/width/height.
   */
  @IsNumber()
  widthPreviewPx: number;

  @IsNumber()
  heightPreviewPx: number;
}

export class SocialSectionTextShadowDto {
  @IsNumber() offsetX: number;
  @IsNumber() offsetY: number;
  @IsNumber() blur: number;
  @IsString() color: string;
}

export class SocialSectionBoxShadowDto {
  @IsNumber() offsetX: number;
  @IsNumber() offsetY: number;
  @IsNumber() blur: number;
  @IsNumber() spread: number;
  @IsString() color: string;
}

/**
 * A single element from the section being organized. Fields mirror the
 * frontend's `CanvasElement` (`TextElement | ImageElement`) but kept
 * intentionally flat so the LLM can read it without complex nesting.
 */
export class SocialSectionElementDto {
  @IsString()
  id: string;

  @IsEnum(['text', 'image'])
  type: 'text' | 'image';

  @IsNumber() x: number;
  @IsNumber() y: number;
  @IsNumber() width: number;
  @IsNumber() height: number;
  @IsNumber() zIndex: number;

  // Text-only fields
  @IsOptional() @IsString() content?: string;
  @IsOptional() @IsNumber() fontSize?: number;
  @IsOptional() @IsString() fontFamily?: string;
  @IsOptional() @IsString() fontWeight?: string;
  @IsOptional() @IsString() fontStyle?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() textAlign?: string;
  @IsOptional() @IsString() textTransform?: string;
  @IsOptional() @IsNumber() lineHeight?: number;
  @IsOptional() @IsNumber() letterSpacing?: number;
  @IsOptional() @IsObject() textShadow?: SocialSectionTextShadowDto;

  // Image-only fields
  @IsOptional() @IsString() src?: string;
  @IsOptional() @IsString() objectFit?: string;
  @IsOptional() @IsNumber() opacity?: number;
  @IsOptional() @IsObject() boxShadow?: SocialSectionBoxShadowDto;
}

export class SocialSectionLayoutRequestDto {
  @ValidateNested()
  @Type(() => SocialSectionDimensionsDto)
  section: SocialSectionDimensionsDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SocialSectionElementDto)
  elements: SocialSectionElementDto[];

  /**
   * Free-text description of what the user wants. We ask for a sane length
   * to avoid massive prompts but otherwise let the user phrase it however
   * they like.
   */
  @IsString()
  @Length(1, 1000)
  instruction: string;

  /**
   * Hint for which section we're editing (header or footer). Used in the
   * prompt to give the LLM context.
   */
  @IsOptional()
  @IsEnum(['header', 'footer'])
  sectionKind?: 'header' | 'footer';
}
