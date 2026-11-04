import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SCENE_LIMITS } from '../domain/scene.types';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class MessageAttachmentDto {
  @ApiProperty({ description: 'Asset da própria cena (logo enviado por upload)' })
  @IsUUID()
  assetId: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

/** Os campos de alvo (região, máscara, elemento) entram no estágio 4. */
export class SendMessageDto {
  @ApiProperty({
    example: 'campo verde com sol à direita',
    maxLength: SCENE_LIMITS.messageMaxLength,
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(SCENE_LIMITS.messageMaxLength)
  content: string;

  @ApiProperty({ description: '`revision` da cena que o cliente viu por último', minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiPropertyOptional({ type: [MessageAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => MessageAttachmentDto)
  attachments?: MessageAttachmentDto[];
}
