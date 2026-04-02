import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class TemplateImageFormatDto {
  @IsString()
  type: string;

  @IsNumber()
  @Min(1)
  printWidthCm: number;

  @IsNumber()
  @Min(1)
  printHeightCm: number;
}

export class TemplateImageMessageDto {
  @IsEnum(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[]; // reference images attached by user (base64 data URLs)
}

export class TemplateImageGenerateRequestDto {
  @ValidateNested()
  @Type(() => TemplateImageFormatDto)
  format: TemplateImageFormatDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateImageMessageDto)
  messages: TemplateImageMessageDto[];
}
