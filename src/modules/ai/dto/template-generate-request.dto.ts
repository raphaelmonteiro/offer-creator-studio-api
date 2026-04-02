import {
  IsString,
  IsNumber,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FormatDto {
  @ApiProperty({ example: 'folheto-20x27' })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiProperty({ example: 20.5 })
  @IsNumber()
  artWidthCm: number;

  @ApiProperty({ example: 27.5 })
  @IsNumber()
  artHeightCm: number;

  @ApiProperty({ example: 6 })
  @IsNumber()
  headerHeightCm: number;

  @ApiProperty({ example: 4 })
  @IsNumber()
  footerHeightCm: number;
}

export class ChatMessageDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsEnum(['user', 'assistant'])
  role: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Base64 data URLs de imagens de referência (apenas em mensagens do usuário)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  images?: string[];
}

export class TemplateGenerateRequestDto {
  @ApiProperty({ type: FormatDto })
  @ValidateNested()
  @Type(() => FormatDto)
  format: FormatDto;

  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}
