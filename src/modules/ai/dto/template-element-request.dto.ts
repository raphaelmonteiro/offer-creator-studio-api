import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsObject,
  ArrayMaxSize,
  ValidateNested,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FormatDto, ChatMessageDto } from './template-generate-request.dto';

export class TemplateElementRequestDto {
  @ApiProperty({ type: FormatDto })
  @ValidateNested()
  @Type(() => FormatDto)
  format: FormatDto;

  @ApiProperty({ enum: ['header', 'footer', 'body'] })
  @IsEnum(['header', 'footer', 'body'])
  activeSection: 'header' | 'footer' | 'body';

  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];

  @ApiPropertyOptional({ description: 'Current template state (JSON, base64 stripped)' })
  @IsOptional()
  @IsObject()
  templateContext?: Record<string, unknown>;
}

// ─── Response types ──────────────────────────────────────────────────────────

export interface ElementAction {
  type: 'add-image' | 'add-text' | 'update-element' | 'remove-element' | 'update-background';
  section: 'header' | 'footer' | 'body';
  element?: Record<string, unknown>;
  elementId?: string;
  updates?: Record<string, unknown>;
  background?: Record<string, unknown>;
}

export interface TemplateElementResponseDto {
  assistantMessage: string;
  actions: ElementAction[];
}
