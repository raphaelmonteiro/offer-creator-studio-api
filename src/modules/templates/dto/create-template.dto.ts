import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsEnum, IsBoolean } from 'class-validator';

export enum TemplateType {
  HEADER = 'header',
  FOOTER = 'footer',
  FULL = 'full',
}

export class CreateTemplateDto {
  @ApiProperty({ example: 'Header Clássico Vermelho' })
  @IsString()
  name: string;

  @ApiProperty({ enum: TemplateType, example: TemplateType.HEADER })
  @IsEnum(TemplateType)
  type: TemplateType;

  @ApiProperty({ type: 'object' })
  @IsObject()
  configuration: any;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
